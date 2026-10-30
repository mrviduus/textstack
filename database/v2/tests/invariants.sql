-- invariants.sql — ADR-031's schema rules, checked against a migrated textstack_v2. Read-only.
--
--   psql -X -v ON_ERROR_STOP=1 -d <db> -f database/v2/tests/invariants.sql
--
-- Each block raises (non-zero exit) with the offending names. Adding or dropping a table means
-- editing the expected set below, on purpose: it is ADR-031's table list.

-- The table set is exactly ADR-031's 24 + 2 transitional.
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
        ('book_chapters'), ('ingestion_jobs')),
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

-- Rule 2: an FK to anything but users starts with user_id (ownership in the key); every table with
-- user_id has an FK, except llm_traces (a trace outlives its user).
DO $$
DECLARE bad text;
BEGIN
    SELECT string_agg(conname, ', ') INTO bad FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confrelid <> 'public.users'::regclass
      AND (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) <> 'user_id';
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'FKs not scoped by user_id: %', bad; END IF;

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
