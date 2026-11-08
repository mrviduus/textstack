-- etl-reader.sql — the SELECT-only source role etl-v2 reads legacy as (runbook: docs/03-ops/v2-etl.md)
--
-- Run against the LEGACY database the ETL reads (a restored rehearsal copy, or production at the
-- cutover), as a role that may create roles. psql 16+ (\getenv). The password is never on argv:
--
--   with ETL_READER_PASSWORD in the environment (read -rs):  psql -v ON_ERROR_STOP=1 -d <db> -f etl-reader.sql
--   without it, the role gets no password here; set one interactively (pre-hashed, never logged):
--                                                             psql -d <db> -c '\password etl_reader'
--
-- The env route sends the password in an ALTER ROLE statement: with log_statement = ddl (or all) the
-- server log records it. Prefer \password where the log level is not known.
--
-- Idempotent: the role is created once per cluster and its attributes are forced on every run; the
-- grants are per database. Grants nothing else and touches no other role's privileges (PUBLIC's
-- included). `etl-v2` audits the login on every run and refuses one that can write.
-- Ops tooling, not application SQL: data-access.md rule 13 covers app code only.

SELECT 'CREATE ROLE etl_reader' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'etl_reader') \gexec

ALTER ROLE etl_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- Empty counts as unset: never ALTER ROLE … PASSWORD ''.
\getenv etl_reader_password ETL_READER_PASSWORD
\if :{?etl_reader_password}
SELECT :'etl_reader_password' <> '' AS etl_reader_password_set \gset
\else
\set etl_reader_password_set false
\endif
\if :etl_reader_password_set
ALTER ROLE etl_reader PASSWORD :'etl_reader_password';
\else
\echo 'ETL_READER_PASSWORD is not set: no password set. Run: \\password etl_reader'
\endif

DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO etl_reader', current_database()); END $$;

GRANT USAGE ON SCHEMA public TO etl_reader;

-- Exactly the tables etl-v2 reads (every EtlV2Step.Sources); a mapper that reads one more adds it here.
GRANT SELECT ON TABLE
    public.users,
    public.admin_users,
    public.user_books,
    public.user_book_files,
    public.user_chapters,
    public.user_ingestion_jobs,
    public.user_libraries,
    public.highlights,
    public.vocabulary_words,
    public.vocabulary_reviews,
    public.book_insight,
    public.review_question,
    public.reading_sessions
TO etl_reader;
