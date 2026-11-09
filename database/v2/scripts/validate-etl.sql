-- validate-etl.sql — re-checks an etl-v2 run (v2-plan §5.2, M3.4) from SQL alone, after a real run on a
-- rehearsal copy or at the cutover. Read-only on both databases: every session defaults to read-only
-- transactions, nothing is created, not even a temporary table.
--
--   psql -X -d '<legacy connection>' -v v2='<textstack_v2 connection>' [-v run_id=<uuid>] -f validate-etl.sql
--
-- The legacy side may be etl_reader (it reads only tables etl-v2 reads). The run checked is run_id, else
-- the newest row of migration_runs. Connection strings: no password on the command line (pgpass or
-- PGPASSWORD for the session), as for etl-v2 itself (docs/03-ops/v2-etl.md §2).
--
-- Output: one row per check, (check, status, details). status is
--   ok      the check holds;
--   FAIL    a mismatch: psql then exits 3 ("validate-etl: N check(s) FAILED");
--   report  a report-only category (runbook §4): V2-only rows, takedowns, non-ready uploads, files with
--           no bytes on disk, session-only pairs, dangling shelf entries, anchors V2 refuses on edit. Listed, never a failure, as
--           long as the ledger names the same rows SQL finds.
-- Exit 0 = every check ok or report.
--
-- How: the legacy half computes, from the source alone, what V2 must hold (each row's key, owner and an
-- md5 of the columns the mapping fixes) into one psql variable; the V2 half compares it with V2 and with
-- the run's ledger row. The mapping rules are etl-v2's (backend/src/Infrastructure/Persistence/Etl/Steps),
-- restated here; the persistence tests run this script after a real run and after corrupting V2.
-- Set names equal the run's Writes names ("books" = uploads, "books (catalog)" = catalog pairs).
--
-- Known ceilings (ponytail): word keys fold with Postgres lower(), etl-v2 with .NET's ToLowerInvariant (white
-- space is trimmed by .NET's set, see the vocabulary CTE), and admin emails with legacy's lower(), etl-v2 with
-- V2's ICU lower() (equal on ASCII and common scripts; a dotted 'İ' could differ). Bytes on disk are not read: a file etl-v2 found missing is
-- taken from the ledger's own orphan list. uuid_v5 is SHA-1 in plain SQL (no pgcrypto/uuid-ossp on either
-- side): ~15 s per 50k ids on pg16; if production's vocabulary outgrows that, compare op ids by sample.

\set ON_ERROR_STOP on
\set QUIET on
\if :{?v2}
\else
    DO $$ BEGIN RAISE EXCEPTION 'validate-etl: pass -v v2=<textstack_v2 connection string>'; END $$;
\endif
\if :{?run_id}
\else
    \set run_id ''
\endif

SET default_transaction_read_only = on;
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET extra_float_digits = 1;
SET statement_timeout = 0;

-- ---------------------------------------------------------------- legacy: what V2 must hold
WITH RECURSIVE
-- BEGIN IntentPairs (verbatim EtlV2Catalog.IntentPairs; a test asserts they are equal)
pair AS (
        WITH intent(user_id, edition_id, at) AS (
            SELECT user_id, edition_id, created_at FROM user_libraries
            UNION ALL SELECT user_id, edition_id, NULL FROM reading_progresses
            UNION ALL SELECT user_id, edition_id, created_at FROM highlights WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM vocabulary_words WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM pending_vocabulary_words WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, first_tapped_at FROM word_lookups WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM word_clusters WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM book_insight WHERE edition_id IS NOT NULL
            UNION ALL SELECT c.user_id, bc.book_id, bc.added_at FROM book_collections bc
                JOIN collections c ON c.id = bc.collection_id WHERE bc.book_type = 'savedbook')
        SELECT i.user_id, i.edition_id, COALESCE(min(i.at), e.created_at) AS created_at, e.id IS NOT NULL AS edition_exists, e.title, e.language,
            jsonb_build_object('kind', 'catalog', 'editionSlug', e.slug)::text AS origin,
            -- The first author by credit order; name and id break ties.
            (SELECT a.name FROM edition_authors ea JOIN authors a ON a.id = ea.author_id
             WHERE ea.edition_id = e.id ORDER BY ea."order", a.name, a.id LIMIT 1) AS author
        FROM intent i LEFT JOIN editions e ON e.id = i.edition_id
        GROUP BY i.user_id, i.edition_id, e.id, e.created_at
        ORDER BY i.user_id, i.edition_id
),
-- END IntentPairs
-- uuid_v5 (RFC 9562 §5.5) in SQL: SHA-1 of ns ‖ name, one 512-bit block (ns ‖ name is ≤ 48 bytes here; one block holds 55).
-- Pinned three ways: the self-test rows below, the persistence tests' vectors, and every catalog/operation id
-- the comparison derives (a wrong one fails each row it names).
v5_name(k, ns, name) AS (
    VALUES ('self:ns', '00000000-0000-0000-0000-000000000000'::uuid, convert_to('textstack-v2', 'UTF8')),
           ('self:rfc', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, convert_to('python.org', 'UTF8'))
    UNION ALL SELECT 'p' || user_id || edition_id, '1bf10a76-ae74-52e8-9c16-a47a8bfdbae1'::uuid, uuid_send(user_id) || uuid_send(edition_id) FROM pair
    UNION SELECT 'o' || id, '1bf10a76-ae74-52e8-9c16-a47a8bfdbae1'::uuid, uuid_send(id) FROM word WHERE has_sentence
    UNION SELECT 'o' || id, '1bf10a76-ae74-52e8-9c16-a47a8bfdbae1'::uuid, uuid_send(id) FROM vocabulary_reviews),
v5_block(k, b) AS (
    SELECT k, m || '\x80'::bytea || decode(repeat('00', 55 - length(m)), 'hex') || int8send(length(m) * 8)
    FROM (SELECT k, uuid_send(ns) || name AS m FROM v5_name) n),
v5_round(k, t, a, b, c, d, e, w) AS (
    SELECT k, 0, 1732584193::bigint, 4023233417::bigint, 2562383102::bigint, 271733878::bigint, 3285377520::bigint,
        ARRAY(SELECT (get_byte(b, 4 * i)::bigint << 24) | (get_byte(b, 4 * i + 1) << 16) | (get_byte(b, 4 * i + 2) << 8) | get_byte(b, 4 * i + 3)
              FROM generate_series(0, 15) i ORDER BY i)
    FROM v5_block
    UNION ALL
    SELECT k, t + 1, ((((a << 5) | (a >> 27)) & 4294967295) + f + e + kt + wt) & 4294967295, a, ((b << 30) | (b >> 2)) & 4294967295, c, d,
        CASE WHEN t < 16 THEN w ELSE w || wt END
    FROM v5_round,
    LATERAL (SELECT CASE WHEN t < 16 THEN w[t + 1] ELSE w[t - 2] # w[t - 7] # w[t - 13] # w[t - 15] END AS x) s,
    LATERAL (SELECT CASE WHEN t < 16 THEN x ELSE ((x << 1) | (x >> 31)) & 4294967295 END AS wt,
                    CASE WHEN t < 20 THEN (b & c) | ((~b) & d) WHEN t < 40 OR t >= 60 THEN b # c # d ELSE (b & c) | (b & d) | (c & d) END AS f,
                    CASE WHEN t < 20 THEN 1518500249 WHEN t < 40 THEN 1859775393 WHEN t < 60 THEN 2400959708 ELSE 3395469782 END AS kt) r
    WHERE t < 80),
v5(k, id) AS (
    SELECT k, encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid
    FROM (SELECT k, decode(lpad(to_hex((a + 1732584193) & 4294967295), 8, '0') || lpad(to_hex((b + 4023233417) & 4294967295), 8, '0')
                     || lpad(to_hex((c + 2562383102) & 4294967295), 8, '0') || lpad(to_hex((d + 271733878) & 4294967295), 8, '0'), 'hex') AS h
          FROM v5_round WHERE t = 80) r),
pair_id AS (SELECT p.*, v.id AS book_id FROM pair p JOIN v5 v ON v.k = 'p' || p.user_id || p.edition_id),
carried_pair AS (SELECT * FROM pair_id WHERE edition_exists),
-- users: legacy users, admins folded onto the user of their email, an admin with no user as its own row.
admin_match AS (
    SELECT a.id AS admin_id, u.id AS user_id FROM admin_users a LEFT JOIN users u ON lower(u.email) = lower(a.email) WHERE a.is_active),
s_users AS (
    SELECT id::text AS k, id AS u, md5(row(email, NULLIF(google_subject, ''), NULLIF(apple_subject, ''), password_hash, name, picture, is_guest,
        last_active_at, native_language, storage_used_bytes, storage_limit_override_bytes, tier, promoted_at, created_at)::text) AS h
    FROM users
    UNION ALL
    SELECT a.id::text, a.id, md5(row(a.email, NULL, NULL, a.password_hash, NULL, NULL, false, NULL, NULL, 0, NULL, 'Free', NULL, a.created_at)::text)
    FROM admin_users a JOIN admin_match m ON m.admin_id = a.id WHERE m.user_id IS NULL),
-- a book's one file etl-v2 can carry (more than one, or an Other format, fails the run: then no row here, and the set check fails too; fb2 carried since 0005)
bf AS (
    SELECT f.*, CASE f.format WHEN 0 THEN 'epub' WHEN 1 THEN 'pdf' WHEN 2 THEN 'fb2' WHEN 3 THEN 'html' END AS fmt
    FROM user_book_files f
    WHERE f.format IN (0, 1, 2, 3) AND (SELECT count(*) FROM user_book_files g WHERE g.user_book_id = f.user_book_id) = 1),
s_books AS (
    SELECT id::text AS k, user_id AS u, md5(row(title, author, language, description, genre, published_year, tags,
        CASE WHEN is_clip THEN jsonb_strip_nulls(jsonb_build_object('kind', 'clip', 'sourceUrl', source_url)) ELSE jsonb_build_object('kind', 'upload') END,
        created_at, updated_at, takedown_at)::text) AS h
    FROM user_books),
s_catalog_books AS (
    SELECT book_id::text AS k, user_id AS u, md5(row(title, author, language, origin::jsonb, created_at, created_at, true)::text) AS h FROM carried_pair),
s_files AS (
    SELECT f.id::text AS k, b.user_id AS u, lower(f.sha256) AS x,
        md5(row(f.user_book_id, CASE f.format WHEN 0 THEN 'epub' WHEN 1 THEN 'pdf' WHEN 2 THEN 'fb2' WHEN 3 THEN 'html' END, f.original_file_name, b.page_count,
            b.toc_json, f.uploaded_at, b.takedown_at, b.takedown_at IS NOT NULL)::text) AS h
    FROM user_book_files f JOIN user_books b ON b.id = f.user_book_id),
s_states AS (
    SELECT b.id::text AS k, b.user_id AS u, f.id AS f,
        md5(row(f.id, CASE WHEN pos_loc IS NOT NULL AND NOT (pos_loc ->> 'scheme' = 'pdf-page' AND f.fmt <> 'pdf') THEN pos_loc ELSE slug_loc END,
            trim_scale(COALESCE(b.progress_percent::text::numeric, 0)), COALESCE(b.completed_at, CASE WHEN b.is_read THEN COALESCE(b.read_at, b.updated_at) END),
            COALESCE(b.progress_client_updated_at, b.progress_updated_at, b.updated_at), COALESCE(b.progress_updated_at, b.updated_at))::text) AS h
    FROM user_books b JOIN bf f ON f.user_book_id = b.id,
    LATERAL (SELECT
        CASE
            WHEN jsonb_typeof(b.progress_position_json) = 'object'
                THEN jsonb_build_object('version', 1, 'scheme', 'textstack-position-v1', 'value', b.progress_position_json)
            WHEN b.progress_position_json IS NULL AND b.progress_locator ~ '^page:[1-9][0-9]{0,8}$'
                THEN jsonb_build_object('version', 1, 'scheme', 'pdf-page', 'value', jsonb_build_object('page', substring(b.progress_locator FROM 6)::int))
            WHEN b.progress_position_json IS NULL AND b.progress_locator ~ '^scroll:.+:[^:]*$'
                THEN jsonb_build_object('version', 1, 'scheme', 'textstack-position-v1',
                     'value', jsonb_build_object('chapterSlug', substring(b.progress_locator FROM '^scroll:(.+):[^:]*$'), 'chapterFraction', 0))
        END AS pos_loc,
        CASE WHEN NULLIF(b.progress_chapter_slug, '') IS NOT NULL
            THEN jsonb_build_object('version', 1, 'scheme', 'textstack-position-v1',
                 'value', jsonb_build_object('chapterSlug', b.progress_chapter_slug, 'chapterFraction', 0))
        END AS slug_loc) l
    WHERE b.progress_locator IS NOT NULL OR b.progress_position_json IS NOT NULL OR b.progress_percent IS NOT NULL
       OR b.completed_at IS NOT NULL OR b.is_read OR NULLIF(b.progress_chapter_slug, '') IS NOT NULL),
s_annotations AS (
    SELECT h.id::text AS k, b.user_id AS u, f.id AS f,
        CASE WHEN f.id IS NOT NULL THEN
            CASE
                WHEN jsonb_typeof(h.anchor_json) <> 'object' THEN NULL
                WHEN h.anchor_json ->> 'kind' = 'pdf' THEN jsonb_build_object('version', 1, 'scheme', 'pdf-page', 'value', h.anchor_json)
                WHEN c.id IS NOT NULL THEN jsonb_build_object('version', 1, 'scheme', 'textstack-anchor-v1',
                    'value', (h.anchor_json - 'chapterId') || o.offsets || jsonb_build_object('chapterKey', COALESCE(c.slug, 'ch-' || c.chapter_number)))
            END::text
        END AS l,
        md5(row(h.user_book_id, h.selected_text, h.note_text, h.color, h.created_at, h.updated_at, h.version)::text) AS h
    FROM highlights h JOIN user_books b ON b.id = h.user_book_id
    LEFT JOIN bf f ON f.user_book_id = h.user_book_id
    LEFT JOIN user_chapters c ON c.id = h.user_chapter_id AND c.user_book_id = h.user_book_id
    CROSS JOIN LATERAL (
-- BEGIN AnchorOffsets (verbatim EtlV2Uploads.AnchorOffsets, #1150; a test asserts they are equal)
        SELECT COALESCE(
            CASE WHEN h.anchor_json ->> 'startOffset' ~ '^[0-9]+$' AND h.anchor_json ->> 'endOffset' ~ '^[0-9]+$'
                      AND jsonb_typeof(h.anchor_json -> 'startOffset') = 'number' AND jsonb_typeof(h.anchor_json -> 'endOffset') = 'number'
                 THEN CASE WHEN (h.anchor_json ->> 'endOffset')::numeric BETWEEN (h.anchor_json ->> 'startOffset')::numeric AND 2147483647 THEN '{}'::jsonb END END,
            (SELECT jsonb_build_object('startOffset', regexp_instr(c.plain_text, t.pat, 1, 1, 0, '', 1) - 1,
                                       'endOffset', regexp_instr(c.plain_text, t.pat, 1, 1, 1, '', 1) - 1)
             FROM (SELECT array_agg(regexp_replace(regexp_replace(regexp_replace(regexp_replace(COALESCE(u.s, ''),
                              '\s+(?=[]).,;:!?…}»”’›])', '', 'g'), '([^\w\s])', '\\\1', 'g'), '\\([]).,;:!?…}»”’›])', '\\s*\\\1', 'g'), '\s+', '\\s+', 'g')
                          ORDER BY u.i) AS p
                   FROM unnest(ARRAY[h.anchor_json ->> 'prefix', h.anchor_json ->> 'exact', h.anchor_json ->> 'suffix']) WITH ORDINALITY u(s, i)) q,
                  LATERAL (VALUES (1, q.p[1] || '(' || q.p[2] || ')' || q.p[3]), (2, q.p[1] || '(' || q.p[2] || ')'),
                                  (3, '(' || q.p[2] || ')' || q.p[3]), (4, '(' || q.p[2] || ')')) t(n, pat)
             WHERE CASE WHEN jsonb_typeof(h.anchor_json -> 'exact') = 'string' AND char_length(h.anchor_json ->> 'exact') BETWEEN 1 AND 4000
                             AND char_length(COALESCE(h.anchor_json ->> 'prefix', '')) <= 32 AND char_length(COALESCE(h.anchor_json ->> 'suffix', '')) <= 32
                        THEN c.plain_text ~ t.pat END
             ORDER BY t.n LIMIT 1),
            '{}') AS offsets
-- END AnchorOffsets
    ) o),
s_catalog_annotations AS (
    SELECT h.id::text AS k, h.user_id AS u,
        md5(row(p.book_id, h.selected_text, h.note_text, h.color, h.created_at, h.updated_at, h.version, true)::text) AS h
    FROM highlights h JOIN carried_pair p ON p.user_id = h.user_id AND p.edition_id = h.edition_id
    WHERE h.user_book_id IS NULL),
s_chapters AS (
    SELECT c.id::text AS k, b.user_id AS u, f.id AS f,
        md5(row(b.id, f.id, COALESCE(c.slug, 'ch-' || c.chapter_number), c.chapter_number, c.title, md5(c.html), md5(c.plain_text), c.word_count,
            c.source_start_page, c.source_end_page, c.created_at)::text) AS h
    FROM user_chapters c JOIN user_books b ON b.id = c.user_book_id AND b.takedown_at IS NULL JOIN bf f ON f.user_book_id = b.id),
s_jobs AS (
    SELECT j.id::text AS k, b.user_id AS u, f.id AS f,
        md5(row(b.id, f.id, CASE j.status WHEN 0 THEN 'queued' WHEN 1 THEN 'processing' WHEN 2 THEN 'succeeded' WHEN 3 THEN 'failed' END,
            j.attempt_count, j.error, lower(j.source_format), j.created_at, j.started_at, j.finished_at)::text) AS h
    FROM user_ingestion_jobs j JOIN user_books b ON b.id = j.user_book_id JOIN bf f ON f.id = j.user_book_file_id AND f.user_book_id = j.user_book_id),
-- vocabulary: one card per (user, language, word key); the survivor = most reviews, then newest update, then lowest id.
-- White space is .NET's (char.IsWhiteSpace: Trim, IsNullOrWhiteSpace), not Postgres \s alone, which misses NBSP, U+202F and the
-- other Unicode spaces: the class below is \s plus those.
word AS (
    SELECT w.*, row_number() OVER g AS rnk, first_value(w.id) OVER g AS survivor
    FROM (SELECT w.*, COALESCE(NULLIF(btrim(c.slug), ''), 'ch-' || c.chapter_number) AS chapter_key,
              lower(regexp_replace(w.language, '^[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$', '', 'g')) AS lang,
              lower(regexp_replace(w.word, '^[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$', '', 'g')) AS wkey,
              w.sentence ~ '[^\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]' AS has_sentence,
              w.translation ~ '[^\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]' AS has_translation,
              w.definition ~ '[^\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]' AS has_definition
          FROM vocabulary_words w LEFT JOIN chapters c ON c.id = w.chapter_id AND c.edition_id = w.edition_id) w
    WINDOW g AS (PARTITION BY w.user_id, w.lang, w.wkey ORDER BY w.total_reviews DESC, w.updated_at DESC, w.id)),
s_words AS (
    SELECT s.id::text AS k, s.user_id AS u,
        md5(row(s.lang, s.word, s.wkey, COALESCE(g.translation, s.translation), COALESCE(g.definition, s.definition), s.stage,
            trim_scale(s.interval_days::text::numeric), s.consecutive_correct, s.next_review_at, s.last_reviewed_at, s.created_at, s.updated_at,
            CASE WHEN s.is_retired THEN COALESCE(s.retired_at, s.updated_at) END)::text) AS h
    FROM word s
    JOIN (SELECT survivor, (array_agg(translation ORDER BY rnk) FILTER (WHERE has_translation))[1] AS translation,
                 (array_agg(definition ORDER BY rnk) FILTER (WHERE has_definition))[1] AS definition
          FROM word GROUP BY survivor) g ON g.survivor = s.id
    WHERE s.rnk = 1),
s_examples AS (
    SELECT o.id::text AS k, w.user_id AS u,
        md5(row(w.survivor, COALESCE(w.user_book_id, p.book_id), CASE WHEN w.user_book_id IS NULL THEN w.chapter_key END, w.book_title, w.sentence,
            o.id, w.created_at)::text) AS h
    FROM word w JOIN v5 o ON o.k = 'o' || w.id
    LEFT JOIN pair_id p ON p.user_id = w.user_id AND p.edition_id = w.edition_id
    WHERE w.has_sentence),
s_reviews AS (
    SELECT r.id::text AS k, w.user_id AS u,
        md5(row(w.survivor, o.id, r.review_mode, r.is_correct, r.response_time_ms, r.stage_before, r.stage_after,
            date_trunc('milliseconds', r.created_at), r.created_at)::text) AS h
    FROM vocabulary_reviews r JOIN word w ON w.id = r.vocabulary_word_id JOIN v5 o ON o.k = 'o' || r.id),
s_insights AS (
    SELECT i.id::text AS k, i.user_id AS u,
        md5(row(COALESCE(i.user_book_id, p.book_id), i.chapter_slug, i.text, i.question, i.source, i.review_json, i.created_at, i.updated_at)::text) AS h
    FROM book_insight i LEFT JOIN pair_id p ON p.user_id = i.user_id AND p.edition_id = i.edition_id),
s_questions AS (
    SELECT id::text AS k, user_id AS u,
        md5(row(book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at,
            total_reviews, correct_reviews, is_retired, created_at, updated_at)::text) AS h
    FROM review_question),
s_sessions AS (
    SELECT s.id::text AS k, s.user_id AS u,
        md5(row(COALESCE(s.user_book_id, p.book_id), s.id, s.started_at, s.ended_at, s.duration_seconds, s.words_read,
            trim_scale(s.start_percent::text::numeric), trim_scale(s.end_percent::text::numeric), s.deleted_book_sha256, s.created_at)::text) AS h
    FROM reading_sessions s LEFT JOIN carried_pair p ON p.user_id = s.user_id AND p.edition_id = s.edition_id)
SELECT jsonb_build_object(
    'sets', jsonb_build_object(
        'users', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_users s),
        'books', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_books s),
        'books (catalog)', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_catalog_books s),
        'book_files', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_files s),
        'reading_state', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_states s),
        'annotations', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_annotations s),
        'annotations (catalog)', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_catalog_annotations s),
        'book_chapters', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_chapters s),
        'ingestion_jobs', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_jobs s),
        'vocabulary_words', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_words s),
        'vocabulary_examples', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_examples s),
        'vocabulary_reviews', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_reviews s),
        'book_insight', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_insights s),
        'review_question', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_questions s),
        'reading_sessions', (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]') FROM s_sessions s)),
    'admins', (SELECT COALESCE(jsonb_agg(COALESCE(user_id, admin_id)), '[]') FROM admin_match),
    'people', (SELECT COALESCE(jsonb_agg(id), '[]') FROM (SELECT id FROM users UNION SELECT id FROM admin_users) p),
    'review_counts', (SELECT COALESCE(jsonb_object_agg(survivor, n), '{}')
                      FROM (SELECT w.survivor, count(*) AS n FROM vocabulary_reviews r JOIN word w ON w.id = r.vocabulary_word_id GROUP BY 1) c),
    'seconds', (SELECT COALESCE(jsonb_object_agg(user_id, n), '{}') FROM (SELECT user_id, sum(duration_seconds) AS n FROM reading_sessions GROUP BY 1) c),
    'takedowns', (SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]') FROM user_books WHERE takedown_at IS NOT NULL),
    'not_ready', (SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]') FROM user_books WHERE status IN (0, 2)),
    'trail', (SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]') FROM highlights WHERE user_book_id IS NULL AND edition_id IS NULL),
    'dangling', (SELECT COALESCE(jsonb_agg(book_id ORDER BY book_id), '[]') FROM pair_id WHERE NOT edition_exists),
    'session_only', (SELECT COALESCE(jsonb_agg(s.id ORDER BY s.id), '[]') FROM reading_sessions s
                     WHERE s.edition_id IS NOT NULL AND NOT EXISTS (SELECT FROM carried_pair p WHERE p.user_id = s.user_id AND p.edition_id = s.edition_id)),
    'self_test', (SELECT jsonb_object_agg(k, id) FROM v5 WHERE k LIKE 'self:%'),
    'counts', jsonb_build_object(
        'admin_users', (SELECT count(*) FROM admin_users), 'authors', (SELECT count(*) FROM authors),
        'book_collections', (SELECT count(*) FROM book_collections), 'book_insight', (SELECT count(*) FROM book_insight),
        'chapters', (SELECT count(*) FROM chapters), 'collections', (SELECT count(*) FROM collections),
        'edition_authors', (SELECT count(*) FROM edition_authors), 'editions', (SELECT count(*) FROM editions),
        'highlights', (SELECT count(*) FROM highlights), 'pending_vocabulary_words', (SELECT count(*) FROM pending_vocabulary_words),
        'reading_progresses', (SELECT count(*) FROM reading_progresses), 'reading_sessions', (SELECT count(*) FROM reading_sessions),
        'review_question', (SELECT count(*) FROM review_question), 'user_book_files', (SELECT count(*) FROM user_book_files),
        'user_books', (SELECT count(*) FROM user_books), 'user_chapters', (SELECT count(*) FROM user_chapters),
        'user_ingestion_jobs', (SELECT count(*) FROM user_ingestion_jobs), 'user_libraries', (SELECT count(*) FROM user_libraries),
        'users', (SELECT count(*) FROM users), 'vocabulary_reviews', (SELECT count(*) FROM vocabulary_reviews),
        'vocabulary_words', (SELECT count(*) FROM vocabulary_words), 'word_clusters', (SELECT count(*) FROM word_clusters),
        'word_lookups', (SELECT count(*) FROM word_lookups))
) AS legacy
\gset

-- ---------------------------------------------------------------- V2: compare
\connect :v2
\set ON_ERROR_STOP on
SET default_transaction_read_only = on;
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET extra_float_digits = 1;
SET statement_timeout = 0;

WITH
l AS (SELECT CAST(:'legacy' AS jsonb) AS j),
run AS (
    SELECT * FROM migration_runs
    WHERE id = COALESCE(NULLIF(:'run_id', '')::uuid, (SELECT id FROM migration_runs ORDER BY started_at DESC, id DESC LIMIT 1))),
orphan AS (SELECT jsonb_array_elements_text(validation -> 'orphanCandidates') AS line FROM run),
cleanup AS (SELECT jsonb_array_elements_text(validation -> 'cleanupActions') AS line FROM run),
-- files etl-v2 found no bytes for (the ledger's word: SQL cannot see the disk): expected absent, and so is what hangs on them
excused AS (SELECT (regexp_match(line, '^user_book_files (\S+): no bytes on disk'))[1]::uuid AS f FROM orphan WHERE line ~ '^user_book_files \S+: no bytes on disk'),
catalog_book AS (SELECT id FROM books WHERE origin ->> 'kind' = 'catalog'),
exp AS (
    SELECT s.key AS t, e.* FROM l, jsonb_each(l.j -> 'sets') s, jsonb_to_recordset(s.value) AS e(k text, u uuid, h text, f uuid, l text, x text)),
act(t, k, u, h, f, l, x) AS (
    SELECT 'users', id::text, id, md5(row(email, google_subject, apple_subject, password_hash, name, picture, is_guest, last_active_at, native_language,
        storage_used_bytes, storage_limit_override_bytes, tier, promoted_at, created_at)::text), NULL::uuid, NULL::text, NULL::text
    FROM users
    UNION ALL
    SELECT CASE WHEN origin ->> 'kind' = 'catalog' THEN 'books (catalog)' ELSE 'books' END, id::text, user_id,
        CASE WHEN origin ->> 'kind' = 'catalog'
            THEN md5(row(title, author, language, origin, created_at, updated_at,
                description IS NULL AND cover_key IS NULL AND genre IS NULL AND published_year IS NULL AND tags = '{}')::text)
            ELSE md5(row(title, author, language, description, genre, published_year, tags, origin, created_at, updated_at, removed_at)::text) END,
        NULL, NULL, NULL
    FROM books
    UNION ALL
    SELECT 'book_files', id::text, user_id,
        md5(row(book_id, format, original_name, page_count, toc, created_at, content_removed_at, server_storage_key IS NULL)::text), NULL, NULL, sha256
    FROM book_files
    UNION ALL
    SELECT 'reading_state', book_id::text, user_id,
        md5(row(file_id, current_locator, trim_scale(book_fraction), completed_at, client_recorded_at, updated_at)::text), file_id, NULL, NULL
    FROM reading_state
    UNION ALL
    SELECT CASE WHEN book_id IN (SELECT id FROM catalog_book) THEN 'annotations (catalog)' ELSE 'annotations' END, id::text, user_id,
        CASE WHEN book_id IN (SELECT id FROM catalog_book)
            THEN md5(row(book_id, selected_text, note_text, color, created_at, updated_at, revision, file_id IS NULL AND locator IS NULL)::text)
            ELSE md5(row(book_id, selected_text, note_text, color, created_at, updated_at, revision)::text) END,
        CASE WHEN book_id NOT IN (SELECT id FROM catalog_book) THEN file_id END,
        CASE WHEN book_id NOT IN (SELECT id FROM catalog_book) THEN locator::text END, NULL
    FROM annotations
    UNION ALL
    SELECT 'book_chapters', id::text, user_id,
        md5(row(book_id, file_id, chapter_key, chapter_number, title, md5(html), md5(plain_text), word_count, source_start_page, source_end_page,
            created_at)::text), file_id, NULL, NULL
    FROM book_chapters
    UNION ALL
    SELECT 'ingestion_jobs', id::text, user_id,
        md5(row(book_id, file_id, status, attempt_count, error, source_format, created_at, started_at, finished_at)::text), file_id, NULL, NULL
    FROM ingestion_jobs
    UNION ALL
    SELECT 'vocabulary_words', id::text, user_id,
        md5(row(language, word, word_key, translation, definition, stage, trim_scale(interval_days), consecutive_correct, next_review_at,
            last_reviewed_at, created_at, updated_at, retired_at)::text), NULL, NULL, NULL
    FROM vocabulary_words
    UNION ALL
    SELECT 'vocabulary_examples', id::text, user_id,
        md5(row(word_id, book_id, chapter_key, book_title, sentence, operation_id, created_at)::text), NULL, NULL, NULL
    FROM vocabulary_examples
    UNION ALL
    SELECT 'vocabulary_reviews', id::text, user_id,
        md5(row(word_id, operation_id, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at)::text),
        NULL, NULL, NULL
    FROM vocabulary_reviews
    UNION ALL
    SELECT 'book_insight', id::text, user_id,
        md5(row(book_id, chapter_slug, text, question, source, review_json, created_at, updated_at)::text), NULL, NULL, NULL
    FROM book_insight
    UNION ALL
    SELECT 'review_question', id::text, user_id,
        md5(row(book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at,
            total_reviews, correct_reviews, is_retired, created_at, updated_at)::text), NULL, NULL, NULL
    FROM review_question
    UNION ALL
    SELECT 'reading_sessions', id::text, user_id,
        md5(row(book_id, client_session_id, started_at, ended_at, duration_seconds, words_read, trim_scale(start_percent), trim_scale(end_percent),
            deleted_book_sha256, created_at)::text), NULL, NULL, NULL
    FROM reading_sessions),
cmp AS (
    SELECT COALESCE(e.t, a.t) AS t, COALESCE(e.k, a.k) AS k,
        CASE
            WHEN a.k IS NULL AND ((e.t = 'book_files' AND e.k::uuid IN (SELECT f FROM excused))
                               OR (e.t IN ('reading_state', 'book_chapters', 'ingestion_jobs') AND e.f IN (SELECT f FROM excused))) THEN 'excused'
            WHEN a.k IS NULL THEN 'missing'
            WHEN e.k IS NULL THEN 'v2-only'
            WHEN a.u IS DISTINCT FROM e.u THEN 'owner'
            WHEN a.h IS DISTINCT FROM e.h OR (e.x IS NOT NULL AND e.x IS DISTINCT FROM a.x)
              OR a.f IS DISTINCT FROM (CASE WHEN e.f IN (SELECT f FROM excused) THEN NULL ELSE e.f END)
              OR a.l IS DISTINCT FROM (CASE WHEN e.f IN (SELECT f FROM excused) THEN NULL ELSE e.l END) THEN 'differs'
            ELSE 'ok'
        END AS verdict
    FROM exp e FULL JOIN act a ON a.t = e.t AND a.k = e.k),
per_set AS (
    SELECT s.key AS t,
        count(c.k) FILTER (WHERE c.verdict <> 'v2-only') AS legacy_n,
        count(c.k) FILTER (WHERE c.verdict = 'excused') AS excused_n,
        count(c.k) FILTER (WHERE c.verdict NOT IN ('missing', 'excused')) AS v2_n,
        count(c.k) FILTER (WHERE c.verdict = 'v2-only') AS v2_only,
        count(c.k) FILTER (WHERE c.verdict IN ('missing', 'owner', 'differs')) AS bad,
        string_agg(c.verdict || ' ' || c.k, ', ' ORDER BY c.verdict, c.k) FILTER (WHERE c.verdict IN ('missing', 'owner', 'differs')) AS bad_ids
    FROM l, jsonb_each(l.j -> 'sets') s LEFT JOIN cmp c ON c.t = s.key
    GROUP BY s.key),
-- the ledger's lists, by the id each line names
ledger_ids(category, id) AS (
    SELECT 'takedowns', (regexp_match(line, '^user_books (\S+): taken down;'))[1] FROM orphan WHERE line ~ '^user_books \S+: taken down;'
    UNION ALL SELECT 'trail', (regexp_match(line, '^highlights (\S+): no upload and no edition'))[1] FROM orphan WHERE line ~ '^highlights \S+: no upload and no edition'
    UNION ALL SELECT 'dangling', (regexp_match(line, '^catalog_pairs (\S+): edition \S+ is gone'))[1] FROM orphan WHERE line ~ '^catalog_pairs \S+: edition \S+ is gone'
    UNION ALL SELECT 'session_only', (regexp_match(line, '^reading_sessions (\S+): session-only catalog pair'))[1] FROM orphan WHERE line ~ '^reading_sessions \S+: session-only catalog pair'
    UNION ALL SELECT 'not_ready', (regexp_match(line, '^user_books (\S+): legacy status'))[1] FROM cleanup WHERE line ~ '^user_books \S+: legacy status'
    -- one line per (annotation, reason): kept as "<id> <reason>"
    UNION ALL SELECT 'refused_anchor', m[1] || ' ' || m[2] FROM orphan, LATERAL regexp_match(line, '^highlights (\S+): anchor V2 refuses on edit \(([^)]*)\)') m
        WHERE m IS NOT NULL),
category(ord, category, label) AS (VALUES
    (1, 'takedowns', 'takedowns (carried hidden, no bytes, no chapters)'), (2, 'not_ready', 'non-ready uploads (Processing/Failed, carried)'),
    (3, 'trail', 'deleted-upload highlight trail (not carried)'), (4, 'dangling', 'catalog pairs whose edition is gone (not carried)'),
    (5, 'session_only', 'session-only catalog pairs (carried with no book)')),
v2_counts AS (
    SELECT jsonb_build_object(
        'annotations', (SELECT count(*) FROM annotations), 'book_chapters', (SELECT count(*) FROM book_chapters),
        'book_files', (SELECT count(*) FROM book_files), 'book_insight', (SELECT count(*) FROM book_insight), 'books', (SELECT count(*) FROM books),
        'ingestion_jobs', (SELECT count(*) FROM ingestion_jobs), 'reading_sessions', (SELECT count(*) FROM reading_sessions),
        'reading_state', (SELECT count(*) FROM reading_state), 'review_question', (SELECT count(*) FROM review_question),
        'users', (SELECT count(*) FROM users), 'vocabulary_examples', (SELECT count(*) FROM vocabulary_examples),
        'vocabulary_reviews', (SELECT count(*) FROM vocabulary_reviews), 'vocabulary_words', (SELECT count(*) FROM vocabulary_words)) AS j),
owned(t, user_id) AS (
    SELECT 'books', user_id FROM books UNION ALL SELECT 'book_files', user_id FROM book_files
    UNION ALL SELECT 'reading_state', user_id FROM reading_state UNION ALL SELECT 'annotations', user_id FROM annotations
    UNION ALL SELECT 'book_chapters', user_id FROM book_chapters UNION ALL SELECT 'ingestion_jobs', user_id FROM ingestion_jobs
    UNION ALL SELECT 'vocabulary_words', user_id FROM vocabulary_words UNION ALL SELECT 'vocabulary_examples', user_id FROM vocabulary_examples
    UNION ALL SELECT 'vocabulary_reviews', user_id FROM vocabulary_reviews UNION ALL SELECT 'book_insight', user_id FROM book_insight
    UNION ALL SELECT 'review_question', user_id FROM review_question UNION ALL SELECT 'reading_sessions', user_id FROM reading_sessions),
-- a row whose owner is not its parent's owner (part 1; the composite FKs say it cannot be: this proves it)
foreign_parent(t, id) AS (
    SELECT 'book_files', x.id FROM book_files x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id
    UNION ALL SELECT 'reading_state', x.book_id FROM reading_state x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id
    UNION ALL SELECT 'annotations', x.id FROM annotations x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id
    UNION ALL SELECT 'book_chapters', x.id FROM book_chapters x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id
    UNION ALL SELECT 'ingestion_jobs', x.id FROM ingestion_jobs x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id
    UNION ALL SELECT 'vocabulary_examples', x.id FROM vocabulary_examples x JOIN vocabulary_words w ON w.id = x.word_id WHERE w.user_id <> x.user_id
    UNION ALL SELECT 'vocabulary_examples', x.id FROM vocabulary_examples x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id
    UNION ALL SELECT 'vocabulary_reviews', x.id FROM vocabulary_reviews x JOIN vocabulary_words w ON w.id = x.word_id WHERE w.user_id <> x.user_id
    UNION ALL SELECT 'book_insight', x.id FROM book_insight x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id
    UNION ALL SELECT 'review_question', x.id FROM review_question x JOIN book_insight i ON i.id = x.book_insight_id WHERE i.user_id <> x.user_id
    UNION ALL SELECT 'reading_sessions', x.id FROM reading_sessions x JOIN books b ON b.id = x.book_id WHERE b.user_id <> x.user_id),
-- part 3: every carried textstack-anchor-v1 annotation's text is in its chapter's plain_text (whitespace runs collapsed, no whitespace before
-- closing punctuation, otherwise strict; the same normalization as etl-v2's, owner 2026-11-09).
-- A takedown's chapters are not carried: etl-v2 checked its annotations against legacy's, and so does nothing here.
quote_missing AS (
    SELECT a.id FROM annotations a
    WHERE a.locator ->> 'scheme' = 'textstack-anchor-v1'
      AND a.id::text IN (SELECT k FROM exp WHERE t = 'annotations')
      AND a.book_id::text NOT IN (SELECT jsonb_array_elements_text(j -> 'takedowns') FROM l)
      AND NOT EXISTS (SELECT FROM book_chapters c
                      WHERE c.file_id = a.file_id AND c.user_id = a.user_id AND c.chapter_key = a.locator -> 'value' ->> 'chapterKey'
                        AND strpos(regexp_replace(regexp_replace(c.plain_text, '\s+', ' ', 'g'), '\s+(?=[]).,;:!?…}»”’›])', '', 'g'),
                                   regexp_replace(regexp_replace(a.selected_text, '\s+', ' ', 'g'), '\s+(?=[]).,;:!?…}»”’›])', '', 'g')) > 0)),
-- #1150: what V2's write rule refuses in a carried textstack-anchor-v1 annotation (SyncValidation.IsTextAnchor), one row per
-- reason, as etl-v2's AnchorRefusals lists them: exact 1..4000 code points, prefix/suffix 0..32, int32 offsets >= 0 with
-- end >= start. The quote reason only where etl-v2 looked for the quote (exact and context within those caps).
anchor_refusal(k) AS (
    SELECT a.id::text || ' ' || r.reason FROM annotations a,
        LATERAL (SELECT a.locator -> 'value' AS v) x,
        LATERAL (SELECT jsonb_typeof(x.v -> 'exact') = 'string' AND char_length(x.v ->> 'exact') BETWEEN 1 AND 4000 AS exact_ok,
                        jsonb_typeof(x.v -> 'prefix') = 'string' AND char_length(x.v ->> 'prefix') <= 32
                            AND jsonb_typeof(x.v -> 'suffix') = 'string' AND char_length(x.v ->> 'suffix') <= 32 AS context_ok,
                        char_length(COALESCE(x.v ->> 'prefix', '')) <= 32 AND char_length(COALESCE(x.v ->> 'suffix', '')) <= 32 AS context_bounded,
                        COALESCE(CASE WHEN x.v ->> 'startOffset' ~ '^[0-9]+$' AND x.v ->> 'endOffset' ~ '^[0-9]+$'
                                           AND jsonb_typeof(x.v -> 'startOffset') = 'number' AND jsonb_typeof(x.v -> 'endOffset') = 'number'
                                      THEN (x.v ->> 'endOffset')::numeric BETWEEN (x.v ->> 'startOffset')::numeric AND 2147483647 END, false) AS offsets_ok) f,
        LATERAL (SELECT 'exact missing, empty or over 4000 characters' WHERE NOT COALESCE(f.exact_ok, false)
                 UNION ALL SELECT 'prefix or suffix missing or over 32 characters' WHERE NOT COALESCE(f.context_ok, false)
                 UNION ALL SELECT 'quote not in its chapter''s text, no valid offsets'
                     WHERE NOT f.offsets_ok AND COALESCE(f.exact_ok, false) AND f.context_bounded) r(reason)
    WHERE a.locator ->> 'scheme' = 'textstack-anchor-v1' AND a.id::text IN (SELECT k FROM exp WHERE t = 'annotations')),
review_diff AS (
    SELECT COALESCE(e.key, a.word_id::text) AS id FROM
        (SELECT key, value::bigint AS n FROM l, jsonb_each_text(l.j -> 'review_counts')) e
        FULL JOIN (SELECT word_id, count(*) AS n FROM vocabulary_reviews
                   WHERE word_id::text IN (SELECT k FROM exp WHERE t = 'vocabulary_words') GROUP BY word_id) a ON a.word_id::text = e.key
    WHERE COALESCE(e.n, 0) <> COALESCE(a.n, 0)),
seconds_diff AS (
    SELECT COALESCE(e.key, a.user_id::text) AS id FROM
        (SELECT key, value::bigint AS n FROM l, jsonb_each_text(l.j -> 'seconds')) e
        FULL JOIN (SELECT user_id, sum(duration_seconds) AS n FROM reading_sessions
                   WHERE user_id::text IN (SELECT jsonb_array_elements_text(j -> 'people') FROM l) GROUP BY user_id) a ON a.user_id::text = e.key
    WHERE COALESCE(e.n, 0) <> COALESCE(a.n, 0)),
results(ord, "check", status, details) AS (
    -- the ledger row
    SELECT 10, 'ledger: run succeeded, all its checks passed',
        CASE WHEN r.id IS NOT NULL AND r.outcome = 'succeeded' AND r.validation_failures = 0
                  AND NOT EXISTS (SELECT FROM jsonb_array_elements(r.validation -> 'checks') c WHERE (c ->> 'Failures')::int <> 0)
             THEN 'ok' ELSE 'FAIL' END,
        CASE WHEN r.id IS NULL THEN 'no migration_runs row' || CASE WHEN :'run_id' <> '' THEN ' with id ' || :'run_id' ELSE '' END
             ELSE format('run %s: %s, validation_failures %s, %s checks, source_dump_sha %s', r.id, COALESCE(r.outcome, 'unfinished'),
                  COALESCE(r.validation_failures::text, '-'), jsonb_array_length(COALESCE(r.validation -> 'checks', '[]')), COALESCE(r.source_dump_sha, '-')) END
    FROM (SELECT 1) one LEFT JOIN run r ON true
    UNION ALL
    SELECT 11, 'ledger: no run in flight or unclosed',
        CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END, format('%s unfinished row(s) %s', count(*), COALESCE(string_agg(id::text, ' '), ''))
    FROM migration_runs WHERE finished_at IS NULL
    UNION ALL
    -- the run read this source and left this target: a key either side lacks, or a count that moved, fails
    SELECT 12 + side.n, side.name,
        CASE WHEN count(*) FILTER (WHERE c.ledger IS DISTINCT FROM c.now) = 0 THEN 'ok' ELSE 'FAIL' END,
        format('%s table(s); differ: %s', count(*), COALESCE(string_agg(format('%s ledger %s now %s', c.key, COALESCE(c.ledger::text, '-'), COALESCE(c.now::text, '-')), '; '
            ORDER BY c.key) FILTER (WHERE c.ledger IS DISTINCT FROM c.now), '-'))
    FROM l, v2_counts v,
        -- a failed run records no target counts (JSON null): every V2 count then differs
        LATERAL (VALUES (0, 'ledger: source counts = legacy now', (SELECT counts -> 'source' FROM run), l.j -> 'counts'),
                        (1, 'ledger: target counts = V2 now', (SELECT counts -> 'target' FROM run), v.j)) side0(n, name, ledger0, now),
        LATERAL (SELECT side0.n, side0.name, CASE WHEN jsonb_typeof(side0.ledger0) = 'object' THEN side0.ledger0 ELSE '{}' END AS ledger, side0.now) side,
        LATERAL (SELECT key, side.ledger -> key AS ledger, side.now -> key AS now
                 FROM (SELECT jsonb_object_keys(side.ledger) UNION SELECT jsonb_object_keys(side.now)) k(key)) c
    GROUP BY side.n, side.name
    UNION ALL
    -- what the run says it mapped (inserted + updated + unchanged, a real run's) = what SQL finds it had to
    SELECT 14, 'ledger: writes = rows mapped, per target',
        CASE WHEN d IS NULL THEN 'ok' ELSE 'FAIL' END, COALESCE(d, format('%s targets equal', (SELECT count(*) FROM per_set)))
    FROM (
        SELECT string_agg(format('%s ledger %s mapped %s', COALESCE(w.key, p.t), COALESCE(w.n::text, '-'), COALESCE((p.legacy_n - p.excused_n)::text, '-')), '; '
                          ORDER BY COALESCE(w.key, p.t)) AS d
        FROM (SELECT key, (value ->> 'Inserted')::bigint + (value ->> 'Updated')::bigint + (value ->> 'Unchanged')::bigint AS n
              FROM run, jsonb_each(validation -> 'writes') WHERE key <> 'library_files') w
        FULL JOIN per_set p ON p.t = w.key
        WHERE w.n IS DISTINCT FROM p.legacy_n - p.excused_n) x
    UNION ALL
    -- report-only categories: what SQL finds = what the ledger lists
    SELECT 20 + c.ord, 'report: ' || c.label,
        CASE WHEN sql.ids IS NOT DISTINCT FROM led.ids THEN 'report' ELSE 'FAIL' END,
        format('legacy %s, ledger %s%s', COALESCE(cardinality(sql.ids), 0), COALESCE(cardinality(led.ids), 0),
            CASE WHEN sql.ids IS DISTINCT FROM led.ids THEN ' (the lists differ)' ELSE '' END)
    FROM category c, l,
        LATERAL (SELECT array_agg(v ORDER BY v) AS ids FROM jsonb_array_elements_text(l.j -> c.category) v) sql,
        LATERAL (SELECT array_agg(id ORDER BY id) AS ids FROM ledger_ids WHERE category = c.category) led
    UNION ALL
    SELECT 26, 'report: files with no bytes on disk (from the ledger; their chapters, state and jobs not carried)', 'report',
        format('%s file(s)', count(*)) FROM excused
    UNION ALL
    -- by (table, id): the ledger's key is the row's id, or "(user_id, book_id)" for reading_state (this script keys it by book_id)
    SELECT 27, 'report: V2 rows with no legacy row (cleanup lines, never deleted)',
        CASE WHEN sql.ids IS NOT DISTINCT FROM led.ids THEN 'report' ELSE 'FAIL' END,
        format('%s row(s) found, ledger %s%s', COALESCE(cardinality(sql.ids), 0), COALESCE(cardinality(led.ids), 0),
            CASE WHEN sql.ids IS DISTINCT FROM led.ids THEN ' (the lists differ)' ELSE '' END)
    FROM (SELECT array_agg(t || ' ' || k ORDER BY t || ' ' || k) AS ids FROM cmp WHERE verdict = 'v2-only') sql,
        (SELECT array_agg(x ORDER BY x) AS ids
         FROM (SELECT m[1] || ' ' || (regexp_match(m[2], '([0-9a-f-]{36})\)?$'))[1] AS x
               FROM cleanup, LATERAL regexp_match(line, '^(books \(catalog\)|annotations \(catalog\)|[a-z_]+) ([0-9a-f-]{36}|\([^)]*\)): V2 (?:row|guest|account) with no legacy row') m
               WHERE m IS NOT NULL) l) led
    UNION ALL
    -- #1150: carried anchors V2 refuses on edit (anchor_refusal), by reason; report-only, as long as the ledger names the same (id, reason) pairs.
    SELECT 28, 'report: anchors V2 refuses on edit (quote not found, oversize context, unusable exact; carried as legacy had it)',
        CASE WHEN sql.ids IS NOT DISTINCT FROM led.ids THEN 'report' ELSE 'FAIL' END,
        format('%s found (quote %s, context %s, exact %s), ledger %s%s', COALESCE(cardinality(sql.ids), 0),
            (SELECT count(*) FROM anchor_refusal WHERE k LIKE '% quote %'), (SELECT count(*) FROM anchor_refusal WHERE k LIKE '% prefix %'),
            (SELECT count(*) FROM anchor_refusal WHERE k LIKE '% exact %'), COALESCE(cardinality(led.ids), 0),
            CASE WHEN sql.ids IS DISTINCT FROM led.ids THEN ' (the lists differ)' ELSE '' END)
    FROM (SELECT array_agg(k ORDER BY k) AS ids FROM anchor_refusal) sql,
        (SELECT array_agg(id ORDER BY id) AS ids FROM ledger_ids WHERE category = 'refused_anchor') led
    UNION ALL
    -- per table: count, owner and the mapped columns (parts 1, 2, 4, 5, 6 and insight hashes)
    SELECT 30 + row_number() OVER (ORDER BY t), t || ': legacy vs V2 (count, owner, content)',
        CASE WHEN bad > 0 THEN 'FAIL' ELSE 'ok' END,
        format('legacy %s%s, v2 %s%s', legacy_n, CASE WHEN excused_n > 0 THEN format(' (%s without bytes)', excused_n) ELSE '' END, v2_n,
            CASE WHEN v2_only > 0 THEN format(' (%s v2-only, report)', v2_only) ELSE '' END)
        || CASE WHEN bad > 0 THEN format('; %s bad: %s', bad, left(bad_ids, 400)) ELSE '' END
    FROM per_set
    UNION ALL
    SELECT 60, 'users: legacy admins are admin in V2',
        CASE WHEN count(*) FILTER (WHERE u.role IS DISTINCT FROM 'admin') = 0 THEN 'ok' ELSE 'FAIL' END,
        format('%s admin(s); not admin: %s', count(*), COALESCE(string_agg(a.id, ' ') FILTER (WHERE u.role IS DISTINCT FROM 'admin'), '-'))
    FROM l, jsonb_array_elements_text(l.j -> 'admins') a(id) LEFT JOIN users u ON u.id::text = a.id
    UNION ALL
    SELECT 61, 'ownership: every row''s owner is its parent''s owner',
        CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END, format('%s row(s) %s', count(*), COALESCE(left(string_agg(t || '/' || id, ' '), 400), ''))
    FROM foreign_parent
    UNION ALL
    SELECT 62, 'unknown-user-ids: V2 rows whose owner is in neither legacy nor V2 users',
        CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END, format('%s owner(s) %s', count(*), COALESCE(left(string_agg(t || '/' || user_id, ' '), 400), ''))
    FROM (SELECT DISTINCT t, user_id FROM owned
          WHERE user_id NOT IN (SELECT id FROM users) AND user_id::text NOT IN (SELECT jsonb_array_elements_text(j -> 'people') FROM l)) o
    UNION ALL
    SELECT 63, 'annotations: selected_text in its chapter''s plain_text',
        CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END, format('%s missing %s', count(*), COALESCE(left(string_agg(id::text, ' '), 400), ''))
    FROM quote_missing
    UNION ALL
    SELECT 64, 'vocabulary: review count per survivor (legacy reviews of a merged group vs its V2 reviews)',
        CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END, format('%s card(s) differ %s', count(*), COALESCE(left(string_agg(id, ' '), 400), ''))
    FROM review_diff
    UNION ALL
    SELECT 65, 'reading_sessions: seconds per user',
        CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END, format('%s user(s) differ %s', count(*), COALESCE(left(string_agg(id, ' '), 400), ''))
    FROM seconds_diff
    UNION ALL
    SELECT 66, 'takedowns: no chapters in V2',
        CASE WHEN count(*) = 0 THEN 'ok' ELSE 'FAIL' END, format('%s chapter(s)', count(*))
    FROM l, book_chapters c WHERE c.book_id::text IN (SELECT jsonb_array_elements_text(l.j -> 'takedowns'))
    UNION ALL
    SELECT 70, 'uuid_v5: SQL derivation = EtlV2Ids (self-test vectors)',
        CASE WHEN l.j -> 'self_test' ->> 'self:ns' = '1bf10a76-ae74-52e8-9c16-a47a8bfdbae1'
              AND l.j -> 'self_test' ->> 'self:rfc' = '886313e1-3b8a-5372-9b90-0c9aee199e5d' THEN 'ok' ELSE 'FAIL' END,
        (l.j -> 'self_test')::text
    FROM l)
SELECT jsonb_agg(jsonb_build_object('ord', ord, 'check', "check", 'status', status, 'details', details) ORDER BY ord, "check") AS results,
       count(*) FILTER (WHERE status = 'FAIL') AS failures
FROM results
\gset

SELECT r."check", r.status, r.details FROM jsonb_to_recordset(CAST(:'results' AS jsonb)) AS r(ord int, "check" text, status text, details text) ORDER BY r.ord, r."check";

SET validate_etl.failures = :'failures';
DO $$
BEGIN
    IF current_setting('validate_etl.failures')::int > 0 THEN
        RAISE EXCEPTION 'validate-etl: % check(s) FAILED', current_setting('validate_etl.failures');
    END IF;
END $$;
\echo 'validate-etl: all checks passed'
