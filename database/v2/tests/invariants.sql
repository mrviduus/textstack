-- invariants.sql — ADR-031's schema rules, checked against a migrated textstack_v2. Read-only.
--
--   psql -X -v ON_ERROR_STOP=1 -d <db> -f database/v2/tests/invariants.sql
--
-- Each block raises (non-zero exit) with the offending names. Adding or dropping a table means
-- editing the expected set below, on purpose: it is ADR-031's table list.

-- The table set is exactly ADR-031's 24 + 2 transitional, plus the ETL's ledger (0003, dropped at M6).
DO $$
DECLARE missing text; extra text;
BEGIN
    WITH adr(t) AS (VALUES
        ('users'), ('user_refresh_tokens'), ('password_reset_tokens'), ('oauth_clients'),
        ('oauth_authorization_requests'), ('oauth_grants'), ('device_authorizations'), ('mcp_access_keys'),
        ('books'), ('book_files'),
        ('reading_state'), ('reading_sessions'),
        ('annotations'),
        ('vocabulary_words'), ('vocabulary_examples'), ('vocabulary_reviews'),
        ('shared_chapters'), ('discussion_checkpoints'), ('book_insight'), ('review_question'),
        ('llm_traces'), ('agent_run'), ('eval_runs'), ('admin_settings'),
        ('book_chapters'), ('ingestion_jobs'),
        ('migration_runs')),
    db(t) AS (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations')
    SELECT (SELECT string_agg(t, ', ') FROM (SELECT t FROM adr EXCEPT SELECT t FROM db) m),
           (SELECT string_agg(t, ', ') FROM (SELECT t FROM db EXCEPT SELECT t FROM adr) e)
    INTO missing, extra;
    IF missing IS NOT NULL OR extra IS NOT NULL THEN
        RAISE EXCEPTION 'table set differs from ADR-031: missing [%], extra [%]', coalesce(missing, ''), coalesce(extra, '');
    END IF;
END $$;

-- Rule 1: every table has a COMMENT; the transitional ones carry the sunset sentence.
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(relname, ', ') INTO bad FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations'
      AND obj_description(oid, 'pg_class') IS NULL;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'tables without COMMENT: %', bad; END IF;

    SELECT string_agg(relname, ', ') INTO bad FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relname IN ('book_chapters', 'ingestion_jobs')
      AND obj_description(oid, 'pg_class') NOT LIKE
          'Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031.%';
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'transitional tables without the sunset sentence: %', bad; END IF;
END $$;

-- Rule 2: an FK to anything but users starts with user_id (ownership in the key) and follows an
-- UPDATE of it (the guest→account merge reparents by UPDATE … SET user_id; migration 0001); every
-- table with user_id has an FK, except llm_traces (a trace outlives its user).
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(conname, ', ') INTO bad FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confrelid <> 'public.users'::regclass
      AND (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) <> 'user_id';
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FKs not scoped by user_id: %', bad; END IF;

    SELECT string_agg(conname, ', ') INTO bad FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confrelid <> 'public.users'::regclass
      AND confupdtype <> 'c';
    IF bad IS NOT NULL THEN RAISE EXCEPTION '(user_id, …) FKs without ON UPDATE CASCADE: %', bad; END IF;

    SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'user_id' AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> 'llm_traces'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = c.oid);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'tables with user_id but no FK: %', bad; END IF;
END $$;

-- Rule 9: account delete cascades. An FK that neither cascades/sets null nor is deferred would make
-- DELETE FROM users fail; a deferrable one must be INITIALLY DEFERRED.
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(conname, ', ') INTO bad FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      AND ((confdeltype IN ('a', 'r') AND NOT condeferred) OR (condeferrable AND NOT condeferred));
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FKs that block an account delete: %', bad; END IF;
END $$;

-- Names: pk_<table>, fk_<table>_<reftable>_…, ak_…, ck_…, ix_…; no site_id (rule 10); timestamptz (rule 7).
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(conname, ', ') INTO bad FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND conrelid <> 'public.schema_migrations'::regclass
      AND NOT ((contype = 'p' AND conname = 'pk_' || conrelid::regclass::text)
            OR (contype = 'f' AND conname LIKE 'fk\_' || conrelid::regclass::text || '\_' || confrelid::regclass::text || '\_%')
            OR (contype = 'u' AND conname LIKE 'ak\_' || conrelid::regclass::text || '\_%')
            OR (contype = 'c' AND conname LIKE 'ck\_' || conrelid::regclass::text || '\_%'));
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'constraint names off convention: %', bad; END IF;

    SELECT string_agg(c.relname, ', ') INTO bad FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE c.relnamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = i.indexrelid)
      AND c.relname NOT LIKE 'ix\_' || t.relname || '\_%';
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'index names off convention: %', bad; END IF;

    SELECT string_agg(table_name || '.' || column_name, ', ') INTO bad FROM information_schema.columns
    WHERE table_schema = 'public' AND (column_name = 'site_id' OR data_type = 'timestamp without time zone');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'site_id or timestamp without time zone: %', bad; END IF;
END $$;

-- Rule 6: is_locator() accepts the four schemes and rejects everything else listed.
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(x || ' (expected ' || ok || ')', '; ') INTO bad FROM (VALUES
        ('{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"abc"}', true),
        ('{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)"}', true),
        ('{"version":1,"scheme":"pdf-page","value":{"page":3}}', true),
        ('{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"a"}}', true),
        ('{"version":1,"scheme":"textstack-anchor-v1","value":{"chapterKey":"a"}}', true),
        ('{"version":1,"scheme":"epub-cfi","value":"x","quote":"' || repeat('a', 64) || '"}', true),
        ('{"version":1,"scheme":"epub-cfi","value":"x","quote":"' || repeat('a', 65) || '"}', false),
        ('{"version":1,"scheme":"epub-cfi","value":"x","quote":5}', false),
        -- An empty quote would make every resume check pass; a null value is not a position.
        ('{"version":1,"scheme":"epub-cfi","value":"x","quote":""}', false),
        ('{"version":1,"scheme":"pdf-page","value":null}', false),
        ('{"version":1,"scheme":"pdf-page","value":{"page":3},"quote":"q"}', false),
        ('{"version":2,"scheme":"pdf-page","value":1}', false),
        ('{"version":"1","scheme":"pdf-page","value":1}', false),
        ('{"version":1,"scheme":"pdf-page"}', false),
        ('{"version":1,"scheme":"foo","value":1}', false),
        ('{}', false), ('[1]', false), ('"s"', false), ('null', false)
    ) v(x, ok) WHERE public.is_locator(x::jsonb) IS DISTINCT FROM ok;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'is_locator wrong for: %', bad; END IF;
END $$;

-- Decided item 7 matches accounts by email case-insensitively, so uniqueness must be too.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes
                   WHERE schemaname = 'public' AND indexname = 'ix_users_email'
                     AND indexdef LIKE '%UNIQUE%lower(%email%') THEN
        RAISE EXCEPTION 'ix_users_email is not a unique index on lower(email)';
    END IF;
END $$;

-- Migration 0002's indexes, each with its exact definition: the change feeds page by (updated_at,
-- key) within a user; the due queue in page order over live, unretired cards; a user code shows at
-- most one pending login; a family revoke and the sweep's live-member probe; the two sweeps (the
-- grant sweep's OR needs an index on each arm); one chapter's checkpoints in page order.
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(x.ix, ', ') INTO bad FROM (VALUES
        ('ix_books_user_id_updated_at_id', 'CREATE INDEX % USING btree (user_id, updated_at, id)'),
        ('ix_reading_state_user_id_updated_at_book_id', 'CREATE INDEX % USING btree (user_id, updated_at, book_id)'),
        ('ix_annotations_user_id_updated_at_id', 'CREATE INDEX % USING btree (user_id, updated_at, id)'),
        ('ix_vocabulary_words_user_id_updated_at_id', 'CREATE INDEX % USING btree (user_id, updated_at, id)'),
        ('ix_vocabulary_words_user_id_next_review_at',
         'CREATE INDEX % USING btree (user_id, next_review_at, id) WHERE ((deleted_at IS NULL) AND (retired_at IS NULL))'),
        ('ix_device_authorizations_user_code',
         'CREATE UNIQUE INDEX % USING btree (user_code) WHERE ((status)::text = ''pending''::text)'),
        ('ix_user_refresh_tokens_family_id_expires_at', 'CREATE INDEX % USING btree (family_id, expires_at)'),
        ('ix_password_reset_tokens_expires_at', 'CREATE INDEX % USING btree (expires_at)'),
        ('ix_oauth_grants_refresh_token_expires_at', 'CREATE INDEX % USING btree (refresh_token_expires_at)'),
        ('ix_oauth_grants_revoked_at', 'CREATE INDEX % USING btree (revoked_at) WHERE (revoked_at IS NOT NULL)'),
        ('ix_discussion_checkpoints_user_id_book_id_chapter_key',
         'CREATE INDEX % USING btree (user_id, book_id, chapter_key, created_at, id)')
    ) x(ix, def)
    WHERE NOT EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'public' AND indexname = x.ix AND indexdef LIKE x.def);
    IF bad IS NOT NULL THEN RAISE EXCEPTION '0002 indexes missing or not as defined: %', bad; END IF;
END $$;

-- Migration 0002's columns, present with their nullability: a reset stamps the account; every
-- session names its kind and its family. Whether a replayed token of a live family is found is the
-- repository's sweep and revoke, pinned by its tests.
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(x.t || '.' || x.c, ', ') INTO bad FROM (VALUES
        ('users', 'credentials_reset_at', 'YES'),
        ('user_refresh_tokens', 'kind', 'NO'),
        ('user_refresh_tokens', 'family_id', 'NO')
    ) x(t, c, nullable)
    WHERE NOT EXISTS (SELECT FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = x.t AND column_name = x.c AND is_nullable = x.nullable);
    IF bad IS NOT NULL THEN RAISE EXCEPTION '0002 columns missing or of the wrong nullability: %', bad; END IF;

    IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'ck_user_refresh_tokens_kind'))
       IS DISTINCT FROM 'CHECK ((kind = ANY (ARRAY[''reader''::text, ''admin''::text])))' THEN
        RAISE EXCEPTION 'ck_user_refresh_tokens_kind is not kind IN (reader, admin)';
    END IF;
END $$;

-- Migration 0004: the etl-v2 ledger's rules. It is transitional (dropped at M6); a finished run has an
-- outcome, 'interrupted' among them; counts/validation are objects; a succeeded run carries its
-- validation; source_dump_sha is a SHA-256 hex digest; no clock-order CHECK (a clock step back
-- must not fail a finish). The behaviour is pinned by the etl-v2 tests.
DO $$
DECLARE bad text;
BEGIN
    IF obj_description('public.migration_runs'::regclass, 'pg_class') NOT LIKE 'Transitional. Dropped at M6%' THEN
        RAISE EXCEPTION 'migration_runs COMMENT lacks its sunset sentence';
    END IF;

    SELECT string_agg(c, ', ') INTO bad FROM (VALUES
        ('ck_migration_runs_outcome'), ('ck_migration_runs_finished'), ('ck_migration_runs_counts'),
        ('ck_migration_runs_validation'), ('ck_migration_runs_source_dump_sha')) x(c)
    WHERE NOT EXISTS (SELECT FROM pg_constraint WHERE conname = x.c AND conrelid = 'public.migration_runs'::regclass);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'migration_runs CHECKs missing: %', bad; END IF;

    IF EXISTS (SELECT FROM pg_constraint WHERE conname = 'ck_migration_runs_order') THEN
        RAISE EXCEPTION 'ck_migration_runs_order is back (a clock step would fail a finish)';
    END IF;

    IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'ck_migration_runs_outcome'))
       IS DISTINCT FROM 'CHECK ((outcome = ANY (ARRAY[''succeeded''::text, ''failed''::text, ''interrupted''::text])))' THEN
        RAISE EXCEPTION 'ck_migration_runs_outcome is not outcome IN (succeeded, failed, interrupted)';
    END IF;
END $$;
