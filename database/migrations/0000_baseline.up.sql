-- 0000_baseline — the whole schema as production had it on 2026-10-26, plus seed rows.
--
-- What:  every table, key, index, function and trigger of the TextStack database, grouped by
--        domain in the order of docs/01-architecture/data-model.md (numbers match its inventory).
-- Why:   SQL-first migrations (#931). This file replaces the 147 EF Core migrations that built
--        production; it was made from `pg_dump --schema-only --no-owner` of a restored production
--        backup, and a database built from it dumps to the same schema.
--        It also carries what EF never modelled: the pg_trgm and vector extensions,
--        get_fts_config() and the chapters search-vector trigger, the generated
--        user_chapters.search_vector column and the trigram index on lower(editions.title).
-- Issue: https://github.com/mrviduus/textstack/issues/931
-- Compatibility: runs only on an empty database. Production is not rebuilt from it: migrate.sh
--        finds the EF history table there, records this version as applied and runs nothing.
-- Down:  none. Undoing the baseline means an empty database: drop it and create it again.
--
-- Changing the schema: never edit this file (migrate.sh checks its checksum). Add the next
-- numbered pair, 0001_<name>.up.sql + 0001_<name>.down.sql — see database/README.md.

-- =====================================================================
-- Extensions
-- =====================================================================
-- pg_trgm: the trigram index for fuzzy title search (editions).
-- vector:  pgvector, for vocabulary_words.embedding.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- =====================================================================
-- Full-text search functions
-- =====================================================================
-- get_fts_config(lang): maps a language code to its text-search config.
-- chapters_search_vector_trigger(): keeps chapters.search_vector in step with plain_text.
CREATE FUNCTION public.chapters_search_vector_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            DECLARE
                edition_lang text;
                fts_config regconfig;
            BEGIN
                SELECT language INTO edition_lang FROM editions WHERE id = NEW.edition_id;
                fts_config := get_fts_config(edition_lang);
                NEW.search_vector := to_tsvector(fts_config, COALESCE(NEW.plain_text, ''));
                RETURN NEW;
            END;
            $$;
CREATE FUNCTION public.get_fts_config(lang text) RETURNS regconfig
    LANGUAGE plpgsql IMMUTABLE
    AS $$
                BEGIN
                    CASE lang
                        WHEN 'en' THEN RETURN 'english'::regconfig;
                        ELSE RETURN 'simple'::regconfig;
                    END CASE;
                END;
                $$;

-- =====================================================================
-- Catalog — admin-curated public library, SEO, prerender
-- =====================================================================

-- 1. sites — The one site's settings
CREATE TABLE public.sites (
    id uuid NOT NULL,
    code character varying(50) NOT NULL,
    primary_domain character varying(255) NOT NULL,
    default_language character varying(10) NOT NULL,
    theme character varying(50) NOT NULL,
    ads_enabled boolean NOT NULL,
    indexing_enabled boolean NOT NULL,
    sitemap_enabled boolean NOT NULL,
    features_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.sites
    ADD CONSTRAINT pk_sites PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_sites_code ON public.sites USING btree (code);
CREATE UNIQUE INDEX ix_sites_primary_domain ON public.sites USING btree (primary_domain);

-- 2. site_domains — Host → site lookup
CREATE TABLE public.site_domains (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    domain character varying(255) NOT NULL,
    is_primary boolean NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.site_domains
    ADD CONSTRAINT pk_site_domains PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_site_domains_domain ON public.site_domains USING btree (domain);
CREATE INDEX ix_site_domains_site_id ON public.site_domains USING btree (site_id);

-- 3. works — Language-neutral book (slug only)
CREATE TABLE public.works (
    id uuid NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    site_id uuid NOT NULL
);
ALTER TABLE ONLY public.works
    ADD CONSTRAINT pk_works PRIMARY KEY (id);
CREATE INDEX ix_works_site_id ON public.works USING btree (site_id);
CREATE UNIQUE INDEX ix_works_site_id_slug ON public.works USING btree (site_id, slug);

-- 4. editions — A published book: title, cover, SEO fields, status
CREATE TABLE public.editions (
    id uuid NOT NULL,
    work_id uuid NOT NULL,
    language character varying(8) NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    status integer NOT NULL,
    published_at timestamp with time zone,
    source_edition_id uuid,
    cover_path text,
    is_public_domain boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    site_id uuid NOT NULL,
    canonical_override text,
    indexable boolean DEFAULT true NOT NULL,
    seo_description text,
    seo_title text,
    toc_json jsonb,
    seo_faqs_json text,
    seo_relevance_text text,
    seo_themes_json text,
    seo_source integer DEFAULT 0 NOT NULL,
    featured_rank integer
);
ALTER TABLE ONLY public.editions
    ADD CONSTRAINT pk_editions PRIMARY KEY (id);
CREATE INDEX idx_editions_title_trgm ON public.editions USING gist (lower(title) public.gist_trgm_ops);
CREATE INDEX ix_editions_site_id ON public.editions USING btree (site_id);
CREATE UNIQUE INDEX ix_editions_site_id_language_slug ON public.editions USING btree (site_id, language, slug);
CREATE INDEX ix_editions_source_edition_id ON public.editions USING btree (source_edition_id);
CREATE INDEX ix_editions_status ON public.editions USING btree (status);
CREATE UNIQUE INDEX ix_editions_work_id_language ON public.editions USING btree (work_id, language);

-- 5. chapters — Chapter HTML, plain text, search_vector (trigger)
CREATE TABLE public.chapters (
    id uuid NOT NULL,
    edition_id uuid NOT NULL,
    chapter_number integer NOT NULL,
    slug text,
    title text NOT NULL,
    html text NOT NULL,
    plain_text text NOT NULL,
    word_count integer,
    search_vector tsvector,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    original_chapter_number integer,
    part_number integer,
    total_parts integer,
    content_quality_score integer
);
ALTER TABLE ONLY public.chapters
    ADD CONSTRAINT pk_chapters PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_chapters_edition_id_chapter_number ON public.chapters USING btree (edition_id, chapter_number);
CREATE INDEX ix_chapters_edition_id_slug ON public.chapters USING btree (edition_id, slug);
CREATE INDEX ix_chapters_search_vector ON public.chapters USING gin (search_vector);
CREATE TRIGGER chapters_search_vector_update BEFORE INSERT OR UPDATE OF plain_text, edition_id ON public.chapters FOR EACH ROW EXECUTE FUNCTION public.chapters_search_vector_trigger();

-- 6. authors — Author pages
CREATE TABLE public.authors (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    slug character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    bio text,
    photo_path text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    indexable boolean NOT NULL,
    seo_title text,
    seo_description text,
    canonical_override text,
    seo_faqs_json text,
    seo_relevance_text text,
    seo_themes_json text,
    seo_source integer DEFAULT 0 NOT NULL,
    external_links_json jsonb
);
ALTER TABLE ONLY public.authors
    ADD CONSTRAINT pk_authors PRIMARY KEY (id);
CREATE INDEX ix_authors_site_id ON public.authors USING btree (site_id);
CREATE UNIQUE INDEX ix_authors_site_id_slug ON public.authors USING btree (site_id, slug);

-- 7. edition_authors — Edition ↔ author, with order and role
CREATE TABLE public.edition_authors (
    edition_id uuid NOT NULL,
    author_id uuid NOT NULL,
    "order" integer DEFAULT 0 NOT NULL,
    role character varying(50) DEFAULT 'Author'::character varying NOT NULL
);
ALTER TABLE ONLY public.edition_authors
    ADD CONSTRAINT pk_edition_authors PRIMARY KEY (edition_id, author_id);
CREATE INDEX ix_edition_authors_author_id ON public.edition_authors USING btree (author_id);

-- 8. genres — Genre pages and filters
CREATE TABLE public.genres (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    slug character varying(100) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    indexable boolean NOT NULL,
    seo_title text,
    seo_description text,
    seo_source integer DEFAULT 0 NOT NULL
);
ALTER TABLE ONLY public.genres
    ADD CONSTRAINT pk_genres PRIMARY KEY (id);
CREATE INDEX ix_genres_site_id ON public.genres USING btree (site_id);
CREATE UNIQUE INDEX ix_genres_site_id_slug ON public.genres USING btree (site_id, slug);

-- 9. edition_genres — Edition ↔ genre join (implicit)
CREATE TABLE public.edition_genres (
    editions_id uuid NOT NULL,
    genres_id uuid NOT NULL
);
ALTER TABLE ONLY public.edition_genres
    ADD CONSTRAINT pk_edition_genres PRIMARY KEY (editions_id, genres_id);
CREATE INDEX ix_edition_genres_genres_id ON public.edition_genres USING btree (genres_id);

-- 10. book_files — Original catalog upload
CREATE TABLE public.book_files (
    id uuid NOT NULL,
    edition_id uuid NOT NULL,
    original_file_name text NOT NULL,
    storage_path text NOT NULL,
    format integer NOT NULL,
    sha256 text,
    uploaded_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.book_files
    ADD CONSTRAINT pk_book_files PRIMARY KEY (id);
CREATE INDEX ix_book_files_edition_id ON public.book_files USING btree (edition_id);
CREATE INDEX ix_book_files_sha256 ON public.book_files USING btree (sha256);

-- 11. book_assets — Inline images extracted from books
CREATE TABLE public.book_assets (
    id uuid NOT NULL,
    edition_id uuid NOT NULL,
    kind character varying(20) NOT NULL,
    original_path character varying(500) NOT NULL,
    storage_path character varying(500) NOT NULL,
    content_type character varying(100) NOT NULL,
    byte_size bigint NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.book_assets
    ADD CONSTRAINT pk_book_assets PRIMARY KEY (id);
CREATE INDEX ix_book_assets_edition_id ON public.book_assets USING btree (edition_id);
CREATE UNIQUE INDEX ix_book_assets_edition_id_original_path ON public.book_assets USING btree (edition_id, original_path);

-- 12. ingestion_jobs — Catalog extraction queue
CREATE TABLE public.ingestion_jobs (
    id uuid NOT NULL,
    edition_id uuid NOT NULL,
    book_file_id uuid NOT NULL,
    target_language character varying(8) NOT NULL,
    work_id uuid,
    source_edition_id uuid,
    status integer NOT NULL,
    attempt_count integer NOT NULL,
    error text,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    confidence double precision,
    source_format character varying(20),
    text_source character varying(20),
    units_count integer,
    warnings_json jsonb
);
ALTER TABLE ONLY public.ingestion_jobs
    ADD CONSTRAINT pk_ingestion_jobs PRIMARY KEY (id);
CREATE INDEX ix_ingestion_jobs_book_file_id ON public.ingestion_jobs USING btree (book_file_id);
CREATE INDEX ix_ingestion_jobs_created_at ON public.ingestion_jobs USING btree (created_at);
CREATE INDEX ix_ingestion_jobs_edition_id ON public.ingestion_jobs USING btree (edition_id);
CREATE INDEX ix_ingestion_jobs_source_edition_id ON public.ingestion_jobs USING btree (source_edition_id);
CREATE INDEX ix_ingestion_jobs_status ON public.ingestion_jobs USING btree (status);
CREATE INDEX ix_ingestion_jobs_work_id ON public.ingestion_jobs USING btree (work_id);

-- 13. lint_results — Extraction lint findings
CREATE TABLE public.lint_results (
    id uuid NOT NULL,
    edition_id uuid NOT NULL,
    severity character varying(20) NOT NULL,
    code character varying(10) NOT NULL,
    message text NOT NULL,
    chapter_number integer,
    line_number integer,
    context text,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.lint_results
    ADD CONSTRAINT pk_lint_results PRIMARY KEY (id);
CREATE INDEX ix_lint_results_edition_id ON public.lint_results USING btree (edition_id);

-- 14. text_stack_imports — Import provenance, Standard Ebooks dedupe
CREATE TABLE public.text_stack_imports (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    identifier character varying(500) NOT NULL,
    edition_id uuid NOT NULL,
    imported_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.text_stack_imports
    ADD CONSTRAINT pk_text_stack_imports PRIMARY KEY (id);
CREATE INDEX ix_text_stack_imports_edition_id ON public.text_stack_imports USING btree (edition_id);
CREATE INDEX ix_text_stack_imports_site_id ON public.text_stack_imports USING btree (site_id);
CREATE UNIQUE INDEX ix_text_stack_imports_site_id_identifier ON public.text_stack_imports USING btree (site_id, identifier);

-- 15. auto_publish_jobs — SEO generate-and-publish queue
CREATE TABLE public.auto_publish_jobs (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    status integer NOT NULL,
    generated_edition_seo boolean NOT NULL,
    generated_author_seo boolean NOT NULL,
    priority boolean NOT NULL,
    error text,
    log_output text,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);
ALTER TABLE ONLY public.auto_publish_jobs
    ADD CONSTRAINT pk_auto_publish_jobs PRIMARY KEY (id);
CREATE INDEX ix_auto_publish_jobs_edition_id ON public.auto_publish_jobs USING btree (edition_id);
CREATE INDEX ix_auto_publish_jobs_site_id ON public.auto_publish_jobs USING btree (site_id);
CREATE INDEX ix_auto_publish_jobs_status ON public.auto_publish_jobs USING btree (status);

-- 16. book_quality_jobs — PDF content-quality cleanup queue
CREATE TABLE public.book_quality_jobs (
    id uuid NOT NULL,
    edition_id uuid,
    user_book_id uuid,
    status integer NOT NULL,
    issues_json jsonb,
    issues_found integer,
    issues_fixed integer,
    error text,
    log_output text,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    content_chapters_cleaned integer,
    content_chapters_rejected integer,
    content_chapters_skipped integer
);
ALTER TABLE ONLY public.book_quality_jobs
    ADD CONSTRAINT pk_book_quality_jobs PRIMARY KEY (id);
CREATE INDEX ix_book_quality_jobs_edition_id ON public.book_quality_jobs USING btree (edition_id);
CREATE INDEX ix_book_quality_jobs_status ON public.book_quality_jobs USING btree (status);
CREATE INDEX ix_book_quality_jobs_user_book_id ON public.book_quality_jobs USING btree (user_book_id);

-- 17. seo_templates — Versioned SEO prompt templates
CREATE TABLE public.seo_templates (
    id uuid NOT NULL,
    entity_type integer NOT NULL,
    field_type integer NOT NULL,
    language_code character varying(8) NOT NULL,
    name character varying(200) NOT NULL,
    description character varying(500),
    prompt_template text NOT NULL,
    output_schema jsonb NOT NULL,
    model character varying(100) NOT NULL,
    max_tokens integer NOT NULL,
    temperature double precision NOT NULL,
    trust_level integer NOT NULL,
    version integer NOT NULL,
    is_active boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.seo_templates
    ADD CONSTRAINT pk_seo_templates PRIMARY KEY (id);
CREATE INDEX ix_seo_templates_entity_type_field_type_language_code_is_active ON public.seo_templates USING btree (entity_type, field_type, language_code, is_active);

-- 18. seo_backfill_jobs — SEO generation audit trail
CREATE TABLE public.seo_backfill_jobs (
    id uuid NOT NULL,
    entity_type integer NOT NULL,
    entity_id uuid NOT NULL,
    target_fields text[] NOT NULL,
    template_ids uuid[] NOT NULL,
    template_versions integer[] NOT NULL,
    status integer NOT NULL,
    input_snapshot jsonb,
    rendered_prompts jsonb,
    raw_outputs jsonb,
    generated_content jsonb,
    before_snapshot jsonb,
    after_snapshot jsonb,
    error text,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    triggered_by character varying(200) NOT NULL,
    requires_review boolean NOT NULL,
    approved_by_user_id uuid,
    approved_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL
);
ALTER TABLE ONLY public.seo_backfill_jobs
    ADD CONSTRAINT pk_seo_backfill_jobs PRIMARY KEY (id);
CREATE INDEX ix_seo_backfill_jobs_entity_type_entity_id ON public.seo_backfill_jobs USING btree (entity_type, entity_id);
CREATE INDEX ix_seo_backfill_jobs_status_created_at ON public.seo_backfill_jobs USING btree (status, created_at);

-- 19. seo_backfill_settings — SEO poller knobs (one row)
CREATE TABLE public.seo_backfill_settings (
    id uuid NOT NULL,
    enabled boolean NOT NULL,
    jobs_per_run integer NOT NULL,
    interval_seconds integer NOT NULL,
    language_filter text[] NOT NULL,
    entity_type_filter text[] NOT NULL,
    ssg_rebuild_batch_minutes integer NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.seo_backfill_settings
    ADD CONSTRAINT pk_seo_backfill_settings PRIMARY KEY (id);

-- 20. ssg_rebuild_jobs — Prerender queue (ssg-worker)
CREATE TABLE public.ssg_rebuild_jobs (
    id uuid NOT NULL,
    site_id uuid NOT NULL,
    mode character varying(20) NOT NULL,
    concurrency integer NOT NULL,
    timeout_ms integer NOT NULL,
    book_slugs_json jsonb,
    author_slugs_json jsonb,
    genre_slugs_json jsonb,
    status character varying(20) NOT NULL,
    total_routes integer NOT NULL,
    rendered_count integer NOT NULL,
    failed_count integer NOT NULL,
    error text,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);
ALTER TABLE ONLY public.ssg_rebuild_jobs
    ADD CONSTRAINT pk_ssg_rebuild_jobs PRIMARY KEY (id);
CREATE INDEX ix_ssg_rebuild_jobs_created_at ON public.ssg_rebuild_jobs USING btree (created_at);
CREATE INDEX ix_ssg_rebuild_jobs_site_id ON public.ssg_rebuild_jobs USING btree (site_id);
CREATE INDEX ix_ssg_rebuild_jobs_status ON public.ssg_rebuild_jobs USING btree (status);

-- 21. ssg_rebuild_results — Per-route prerender result
CREATE TABLE public.ssg_rebuild_results (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    route character varying(500) NOT NULL,
    route_type character varying(20) NOT NULL,
    success boolean NOT NULL,
    render_time_ms integer,
    error text,
    rendered_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.ssg_rebuild_results
    ADD CONSTRAINT pk_ssg_rebuild_results PRIMARY KEY (id);
CREATE INDEX ix_ssg_rebuild_results_job_id ON public.ssg_rebuild_results USING btree (job_id);
CREATE UNIQUE INDEX ix_ssg_rebuild_results_job_id_route ON public.ssg_rebuild_results USING btree (job_id, route);

-- =====================================================================
-- Accounts and access
-- =====================================================================

-- 22. users — Readers, incl. guests
CREATE TABLE public.users (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    email character varying(255) DEFAULT ''::character varying NOT NULL,
    google_subject character varying(255) DEFAULT ''::character varying,
    name character varying(255),
    picture text,
    storage_used_bytes bigint DEFAULT 0 NOT NULL,
    apple_subject character varying(255),
    password_hash character varying(255),
    is_guest boolean DEFAULT false NOT NULL,
    last_active_at timestamp with time zone,
    native_language character varying(16),
    storage_limit_override_bytes bigint,
    tier character varying(20) DEFAULT 'Free'::character varying NOT NULL,
    promoted_at timestamp with time zone
);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT pk_users PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_users_apple_subject ON public.users USING btree (apple_subject) WHERE (apple_subject IS NOT NULL);
CREATE UNIQUE INDEX ix_users_email ON public.users USING btree (email);
CREATE UNIQUE INDEX ix_users_google_subject ON public.users USING btree (google_subject) WHERE (google_subject IS NOT NULL);
CREATE INDEX ix_users_guest_cleanup ON public.users USING btree (is_guest, last_active_at) WHERE (is_guest = true);

-- 23. user_refresh_tokens — Reader sessions
CREATE TABLE public.user_refresh_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    previous_token_hash text
);
ALTER TABLE ONLY public.user_refresh_tokens
    ADD CONSTRAINT pk_user_refresh_tokens PRIMARY KEY (id);
CREATE INDEX ix_user_refresh_tokens_expires_at ON public.user_refresh_tokens USING btree (expires_at);
CREATE INDEX ix_user_refresh_tokens_previous_token_hash ON public.user_refresh_tokens USING btree (previous_token_hash);
CREATE UNIQUE INDEX ix_user_refresh_tokens_token_hash ON public.user_refresh_tokens USING btree (token_hash);
CREATE INDEX ix_user_refresh_tokens_user_id ON public.user_refresh_tokens USING btree (user_id);

-- 24. admin_users — Admin accounts
CREATE TABLE public.admin_users (
    id uuid NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    role integer NOT NULL,
    is_active boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT pk_admin_users PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_admin_users_email ON public.admin_users USING btree (email);

-- 25. admin_refresh_tokens — Admin sessions
CREATE TABLE public.admin_refresh_tokens (
    id uuid NOT NULL,
    admin_user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.admin_refresh_tokens
    ADD CONSTRAINT pk_admin_refresh_tokens PRIMARY KEY (id);
CREATE INDEX ix_admin_refresh_tokens_admin_user_id ON public.admin_refresh_tokens USING btree (admin_user_id);
CREATE INDEX ix_admin_refresh_tokens_expires_at ON public.admin_refresh_tokens USING btree (expires_at);
CREATE UNIQUE INDEX ix_admin_refresh_tokens_token_hash ON public.admin_refresh_tokens USING btree (token_hash);

-- 26. password_reset_tokens — Email reset codes
CREATE TABLE public.password_reset_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(128) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    used boolean NOT NULL
);
ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT pk_password_reset_tokens PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_password_reset_tokens_token_hash ON public.password_reset_tokens USING btree (token_hash);
CREATE INDEX ix_password_reset_tokens_user_id ON public.password_reset_tokens USING btree (user_id);

-- 27. device_authorizations — MCP device-flow codes
CREATE TABLE public.device_authorizations (
    id uuid NOT NULL,
    device_code_hash character varying(128) NOT NULL,
    user_code character varying(16) NOT NULL,
    user_id uuid,
    status character varying(16) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    interval_seconds integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone
);
ALTER TABLE ONLY public.device_authorizations
    ADD CONSTRAINT pk_device_authorizations PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_device_authorizations_device_code_hash ON public.device_authorizations USING btree (device_code_hash);
CREATE INDEX ix_device_authorizations_expires_at ON public.device_authorizations USING btree (expires_at);
CREATE INDEX ix_device_authorizations_user_code ON public.device_authorizations USING btree (user_code) WHERE ((status)::text = 'pending'::text);
CREATE INDEX ix_device_authorizations_user_id ON public.device_authorizations USING btree (user_id);

-- 28. oauth_clients — MCP OAuth clients
CREATE TABLE public.oauth_clients (
    id uuid NOT NULL,
    client_id character varying(512) NOT NULL,
    client_name character varying(100) NOT NULL,
    redirect_uris text[] NOT NULL,
    is_metadata_document boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone
);
ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT pk_oauth_clients PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_oauth_clients_client_id ON public.oauth_clients USING btree (client_id);

-- 29. oauth_authorization_requests — Pending OAuth authorizations
CREATE TABLE public.oauth_authorization_requests (
    id uuid NOT NULL,
    client_id character varying(512) NOT NULL,
    client_name character varying(100) NOT NULL,
    redirect_uri character varying(2048) NOT NULL,
    state character varying(1024),
    code_challenge character varying(128) NOT NULL,
    resource character varying(512) NOT NULL,
    scope character varying(200) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    user_id uuid,
    code_hash character varying(128),
    denied_at timestamp with time zone,
    consumed_at timestamp with time zone
);
ALTER TABLE ONLY public.oauth_authorization_requests
    ADD CONSTRAINT pk_oauth_authorization_requests PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_oauth_authorization_requests_code_hash ON public.oauth_authorization_requests USING btree (code_hash);
CREATE INDEX ix_oauth_authorization_requests_created_at ON public.oauth_authorization_requests USING btree (created_at);

-- 30. oauth_grants — MCP OAuth tokens
CREATE TABLE public.oauth_grants (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id character varying(512) NOT NULL,
    client_name character varying(100) NOT NULL,
    redirect_uri character varying(2048) NOT NULL,
    resource character varying(512) NOT NULL,
    scope character varying(200) NOT NULL,
    access_token_hash character varying(128) NOT NULL,
    access_token_expires_at timestamp with time zone NOT NULL,
    refresh_token_hash character varying(128) NOT NULL,
    refresh_token_expires_at timestamp with time zone NOT NULL,
    previous_refresh_token_hash character varying(128),
    created_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);
ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT pk_oauth_grants PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_oauth_grants_access_token_hash ON public.oauth_grants USING btree (access_token_hash);
CREATE INDEX ix_oauth_grants_previous_refresh_token_hash ON public.oauth_grants USING btree (previous_refresh_token_hash);
CREATE UNIQUE INDEX ix_oauth_grants_refresh_token_hash ON public.oauth_grants USING btree (refresh_token_hash);
CREATE INDEX ix_oauth_grants_user_id ON public.oauth_grants USING btree (user_id);

-- 31. mcp_access_keys — tsk_… connect keys
CREATE TABLE public.mcp_access_keys (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    name character varying(60) NOT NULL,
    key_hash character varying(128) NOT NULL,
    prefix character varying(16) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);
ALTER TABLE ONLY public.mcp_access_keys
    ADD CONSTRAINT pk_mcp_access_keys PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_mcp_access_keys_key_hash ON public.mcp_access_keys USING btree (key_hash);
CREATE INDEX ix_mcp_access_keys_site_id ON public.mcp_access_keys USING btree (site_id);
CREATE INDEX ix_mcp_access_keys_user_id_site_id ON public.mcp_access_keys USING btree (user_id, site_id);

-- 32. admin_settings — Admin key/value settings
CREATE TABLE public.admin_settings (
    key character varying(100) NOT NULL,
    value character varying(500) NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.admin_settings
    ADD CONSTRAINT pk_admin_settings PRIMARY KEY (key);

-- =====================================================================
-- Personal library — user uploads and shelves
-- =====================================================================

-- 33. user_books — A user's uploaded book; also holds its reading progress
CREATE TABLE public.user_books (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(500) NOT NULL,
    slug character varying(500) NOT NULL,
    language character varying(10) NOT NULL,
    description text,
    cover_path character varying(500),
    toc_json jsonb,
    status integer NOT NULL,
    error_message text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    progress_chapter_slug text,
    progress_locator text,
    progress_percent double precision,
    progress_updated_at timestamp with time zone,
    author character varying(500),
    genre character varying(200),
    published_year integer,
    total_word_count integer,
    completed_at timestamp with time zone,
    takedown_at timestamp with time zone,
    takedown_reason character varying(1000),
    metadata_history_json jsonb,
    seo_source character varying(20) DEFAULT 'auto'::character varying NOT NULL,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    suggested_tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    suggested_tags_at timestamp with time zone,
    is_clip boolean DEFAULT false NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    source_url character varying(2048),
    metadata_confidence double precision,
    metadata_provenance_json jsonb,
    metadata_enrichment_at timestamp with time zone,
    metadata_enrichment_status integer DEFAULT 0 NOT NULL,
    progress_position_json jsonb,
    progress_client_updated_at timestamp with time zone,
    page_count integer
);
ALTER TABLE ONLY public.user_books
    ADD CONSTRAINT pk_user_books PRIMARY KEY (id);
CREATE INDEX ix_user_books_status ON public.user_books USING btree (status);
CREATE INDEX ix_user_books_tags ON public.user_books USING gin (tags);
CREATE INDEX ix_user_books_user_id ON public.user_books USING btree (user_id);
CREATE INDEX ix_user_books_user_id_is_clip ON public.user_books USING btree (user_id, is_clip);
CREATE UNIQUE INDEX ix_user_books_user_id_slug ON public.user_books USING btree (user_id, slug);

-- 34. user_chapters — Server-extracted chapters of an upload
CREATE TABLE public.user_chapters (
    id uuid NOT NULL,
    user_book_id uuid NOT NULL,
    chapter_number integer NOT NULL,
    title character varying(500) NOT NULL,
    html text NOT NULL,
    plain_text text NOT NULL,
    word_count integer,
    created_at timestamp with time zone NOT NULL,
    slug character varying(255),
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('english'::regconfig, (COALESCE(title, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(plain_text, ''::text)), 'B'::"char"))) STORED,
    content_quality_score integer,
    source_end_page integer,
    source_start_page integer
);
ALTER TABLE ONLY public.user_chapters
    ADD CONSTRAINT pk_user_chapters PRIMARY KEY (id);
CREATE INDEX ix_user_chapters_search_vector ON public.user_chapters USING gin (search_vector);
CREATE INDEX ix_user_chapters_user_book_id ON public.user_chapters USING btree (user_book_id);
CREATE UNIQUE INDEX ix_user_chapters_user_book_id_chapter_number ON public.user_chapters USING btree (user_book_id, chapter_number);
CREATE UNIQUE INDEX ix_user_chapters_user_book_id_slug ON public.user_chapters USING btree (user_book_id, slug);

-- 35. user_book_files — Original upload file
CREATE TABLE public.user_book_files (
    id uuid NOT NULL,
    user_book_id uuid NOT NULL,
    original_file_name character varying(500) NOT NULL,
    storage_path character varying(500) NOT NULL,
    format integer NOT NULL,
    sha256 character varying(64),
    file_size bigint NOT NULL,
    uploaded_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.user_book_files
    ADD CONSTRAINT pk_user_book_files PRIMARY KEY (id);
CREATE INDEX ix_user_book_files_sha256 ON public.user_book_files USING btree (sha256);
CREATE INDEX ix_user_book_files_user_book_id ON public.user_book_files USING btree (user_book_id);

-- 36. user_ingestion_jobs — Upload extraction queue
CREATE TABLE public.user_ingestion_jobs (
    id uuid NOT NULL,
    user_book_id uuid NOT NULL,
    user_book_file_id uuid NOT NULL,
    status integer NOT NULL,
    attempt_count integer NOT NULL,
    error text,
    source_format character varying(50),
    units_count integer,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);
ALTER TABLE ONLY public.user_ingestion_jobs
    ADD CONSTRAINT pk_user_ingestion_jobs PRIMARY KEY (id);
CREATE INDEX ix_user_ingestion_jobs_created_at ON public.user_ingestion_jobs USING btree (created_at);
CREATE INDEX ix_user_ingestion_jobs_status ON public.user_ingestion_jobs USING btree (status);
CREATE INDEX ix_user_ingestion_jobs_user_book_file_id ON public.user_ingestion_jobs USING btree (user_book_file_id);
CREATE INDEX ix_user_ingestion_jobs_user_book_id ON public.user_ingestion_jobs USING btree (user_book_id);

-- 37. user_book_bookmarks — Bookmarks in uploads
CREATE TABLE public.user_book_bookmarks (
    id uuid NOT NULL,
    user_book_id uuid NOT NULL,
    chapter_id uuid,
    locator character varying(1000) NOT NULL,
    title character varying(500),
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.user_book_bookmarks
    ADD CONSTRAINT pk_user_book_bookmarks PRIMARY KEY (id);
CREATE INDEX ix_user_book_bookmarks_chapter_id ON public.user_book_bookmarks USING btree (chapter_id);
CREATE INDEX ix_user_book_bookmarks_user_book_id ON public.user_book_bookmarks USING btree (user_book_id);

-- 38. user_libraries — Catalog books a user saved
CREATE TABLE public.user_libraries (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.user_libraries
    ADD CONSTRAINT pk_user_libraries PRIMARY KEY (id);
CREATE INDEX ix_user_libraries_edition_id ON public.user_libraries USING btree (edition_id);
CREATE UNIQUE INDEX ix_user_libraries_user_id_edition_id ON public.user_libraries USING btree (user_id, edition_id);

-- 39. collections — Personal shelves
CREATE TABLE public.collections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(20) DEFAULT 'default'::character varying NOT NULL,
    sort_order integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.collections
    ADD CONSTRAINT pk_collections PRIMARY KEY (id);
CREATE INDEX ix_collections_user_id ON public.collections USING btree (user_id);
CREATE INDEX ix_collections_user_id_sort_order ON public.collections USING btree (user_id, sort_order);

-- 40. book_collections — Book on a shelf
CREATE TABLE public.book_collections (
    collection_id uuid NOT NULL,
    book_id uuid NOT NULL,
    book_type character varying(20) NOT NULL,
    added_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.book_collections
    ADD CONSTRAINT pk_book_collections PRIMARY KEY (collection_id, book_id, book_type);
CREATE INDEX ix_book_collections_book_id ON public.book_collections USING btree (book_id);

-- =====================================================================
-- Reading — position, annotations, activity
-- =====================================================================

-- 41. reading_progresses — Position in a catalog book
CREATE TABLE public.reading_progresses (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    chapter_id uuid NOT NULL,
    locator text NOT NULL,
    percent double precision,
    updated_at timestamp with time zone NOT NULL,
    site_id uuid NOT NULL,
    max_chapter_number integer,
    completed_at timestamp with time zone,
    position_json jsonb,
    client_updated_at timestamp with time zone
);
ALTER TABLE ONLY public.reading_progresses
    ADD CONSTRAINT pk_reading_progresses PRIMARY KEY (id);
CREATE INDEX ix_reading_progresses_chapter_id ON public.reading_progresses USING btree (chapter_id);
CREATE INDEX ix_reading_progresses_edition_id ON public.reading_progresses USING btree (edition_id);
CREATE INDEX ix_reading_progresses_site_id ON public.reading_progresses USING btree (site_id);
CREATE UNIQUE INDEX ix_reading_progresses_user_id_site_id_edition_id ON public.reading_progresses USING btree (user_id, site_id, edition_id);

-- 42. bookmarks — Bookmarks in catalog books
CREATE TABLE public.bookmarks (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    chapter_id uuid NOT NULL,
    locator text NOT NULL,
    title text,
    created_at timestamp with time zone NOT NULL,
    site_id uuid NOT NULL
);
ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT pk_bookmarks PRIMARY KEY (id);
CREATE INDEX ix_bookmarks_chapter_id ON public.bookmarks USING btree (chapter_id);
CREATE INDEX ix_bookmarks_edition_id ON public.bookmarks USING btree (edition_id);
CREATE INDEX ix_bookmarks_site_id ON public.bookmarks USING btree (site_id);
CREATE INDEX ix_bookmarks_user_id_site_id_edition_id ON public.bookmarks USING btree (user_id, site_id, edition_id);

-- 43. highlights — Highlights + their note text, catalog or upload
CREATE TABLE public.highlights (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    edition_id uuid,
    chapter_id uuid,
    anchor_json jsonb NOT NULL,
    color character varying(20) NOT NULL,
    selected_text text NOT NULL,
    version integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    note_text text,
    last_reviewed_at timestamp with time zone,
    user_book_id uuid,
    user_chapter_id uuid
);
ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT pk_highlights PRIMARY KEY (id);
CREATE INDEX ix_highlights_chapter_id ON public.highlights USING btree (chapter_id);
CREATE INDEX ix_highlights_edition_id ON public.highlights USING btree (edition_id);
CREATE INDEX ix_highlights_site_id ON public.highlights USING btree (site_id);
CREATE INDEX ix_highlights_user_book_id ON public.highlights USING btree (user_book_id);
CREATE INDEX ix_highlights_user_chapter_id ON public.highlights USING btree (user_chapter_id);
CREATE INDEX ix_highlights_user_id_site_id_edition_id ON public.highlights USING btree (user_id, site_id, edition_id) WHERE (edition_id IS NOT NULL);
CREATE INDEX ix_highlights_user_id_site_id_user_book_id ON public.highlights USING btree (user_id, site_id, user_book_id) WHERE (user_book_id IS NOT NULL);

-- 44. notes — Standalone notes
CREATE TABLE public.notes (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    chapter_id uuid NOT NULL,
    locator text NOT NULL,
    text text NOT NULL,
    version integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    site_id uuid NOT NULL,
    highlight_id uuid
);
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT pk_notes PRIMARY KEY (id);
CREATE INDEX ix_notes_chapter_id ON public.notes USING btree (chapter_id);
CREATE INDEX ix_notes_edition_id ON public.notes USING btree (edition_id);
CREATE UNIQUE INDEX ix_notes_highlight_id ON public.notes USING btree (highlight_id);
CREATE INDEX ix_notes_site_id ON public.notes USING btree (site_id);
CREATE INDEX ix_notes_user_id_site_id_edition_id ON public.notes USING btree (user_id, site_id, edition_id);

-- 45. reading_sessions — Reading time for stats and streaks
CREATE TABLE public.reading_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    edition_id uuid,
    user_book_id uuid,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    duration_seconds integer NOT NULL,
    words_read integer NOT NULL,
    start_percent double precision NOT NULL,
    end_percent double precision NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.reading_sessions
    ADD CONSTRAINT pk_reading_sessions PRIMARY KEY (id);
CREATE INDEX ix_reading_sessions_edition_id ON public.reading_sessions USING btree (edition_id);
CREATE INDEX ix_reading_sessions_site_id ON public.reading_sessions USING btree (site_id);
CREATE INDEX ix_reading_sessions_user_book_id ON public.reading_sessions USING btree (user_book_id);
CREATE UNIQUE INDEX ix_reading_sessions_user_id_edition_id_started_at ON public.reading_sessions USING btree (user_id, edition_id, started_at) WHERE (edition_id IS NOT NULL);
CREATE INDEX ix_reading_sessions_user_id_site_id ON public.reading_sessions USING btree (user_id, site_id);
CREATE INDEX ix_reading_sessions_user_id_started_at ON public.reading_sessions USING btree (user_id, started_at);
CREATE UNIQUE INDEX ix_reading_sessions_user_id_user_book_id_started_at ON public.reading_sessions USING btree (user_id, user_book_id, started_at) WHERE (user_book_id IS NOT NULL);

-- 46. reading_goals — Daily/yearly goal
CREATE TABLE public.reading_goals (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    goal_type character varying(50) NOT NULL,
    target_value integer NOT NULL,
    year integer NOT NULL,
    is_active boolean NOT NULL,
    streak_min_minutes integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.reading_goals
    ADD CONSTRAINT pk_reading_goals PRIMARY KEY (id);
CREATE INDEX ix_reading_goals_site_id ON public.reading_goals USING btree (site_id);
CREATE INDEX ix_reading_goals_user_id_site_id ON public.reading_goals USING btree (user_id, site_id);
CREATE UNIQUE INDEX ix_reading_goals_user_id_site_id_goal_type ON public.reading_goals USING btree (user_id, site_id, goal_type);

-- 47. user_achievements — Unlocked achievements
CREATE TABLE public.user_achievements (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    achievement_code character varying(50) NOT NULL,
    unlocked_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.user_achievements
    ADD CONSTRAINT pk_user_achievements PRIMARY KEY (id);
CREATE INDEX ix_user_achievements_site_id ON public.user_achievements USING btree (site_id);
CREATE INDEX ix_user_achievements_user_id_site_id ON public.user_achievements USING btree (user_id, site_id);
CREATE UNIQUE INDEX ix_user_achievements_user_id_site_id_achievement_code ON public.user_achievements USING btree (user_id, site_id, achievement_code);

-- 48. book_insight — Assistant conclusions + chapter reviews
CREATE TABLE public.book_insight (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    edition_id uuid,
    user_book_id uuid,
    chapter_slug character varying(300),
    text text NOT NULL,
    question character varying(1000),
    source character varying(32) DEFAULT 'mcp'::character varying NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    review_json jsonb,
    CONSTRAINT ck_book_insight_target CHECK ((((edition_id IS NOT NULL) AND (user_book_id IS NULL)) OR ((edition_id IS NULL) AND (user_book_id IS NOT NULL))))
);
ALTER TABLE ONLY public.book_insight
    ADD CONSTRAINT pk_book_insight PRIMARY KEY (id);
CREATE INDEX ix_book_insight_edition_id ON public.book_insight USING btree (edition_id);
CREATE INDEX ix_book_insight_site_id ON public.book_insight USING btree (site_id);
CREATE INDEX ix_book_insight_user_book_id ON public.book_insight USING btree (user_book_id);
CREATE UNIQUE INDEX ix_book_insight_user_id_edition_id_chapter_slug ON public.book_insight USING btree (user_id, edition_id, chapter_slug) NULLS NOT DISTINCT WHERE (edition_id IS NOT NULL);
CREATE UNIQUE INDEX ix_book_insight_user_id_user_book_id_chapter_slug ON public.book_insight USING btree (user_id, user_book_id, chapter_slug) NULLS NOT DISTINCT WHERE (user_book_id IS NOT NULL);

-- 49. review_question — Self-check questions, own SRS queue
CREATE TABLE public.review_question (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    book_insight_id uuid NOT NULL,
    block_index integer NOT NULL,
    prompt character varying(500) NOT NULL,
    answer character varying(1500) NOT NULL,
    prompt_hash character varying(16) NOT NULL,
    stage integer NOT NULL,
    interval_days double precision NOT NULL,
    consecutive_correct integer NOT NULL,
    next_review_at timestamp with time zone NOT NULL,
    last_reviewed_at timestamp with time zone,
    total_reviews integer NOT NULL,
    correct_reviews integer NOT NULL,
    is_retired boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.review_question
    ADD CONSTRAINT pk_review_question PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_review_question_book_insight_id_prompt_hash ON public.review_question USING btree (book_insight_id, prompt_hash);
CREATE INDEX ix_review_question_site_id ON public.review_question USING btree (site_id);
CREATE INDEX ix_review_question_user_id_is_retired_next_review_at ON public.review_question USING btree (user_id, is_retired, next_review_at);

-- =====================================================================
-- Vocabulary and tutor
-- =====================================================================

-- 50. vocabulary_words — Saved words + SRS state
CREATE TABLE public.vocabulary_words (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    word character varying(200) NOT NULL,
    language character varying(8) NOT NULL,
    translation character varying(500),
    definition character varying(2000),
    edition_id uuid,
    chapter_id uuid,
    user_book_id uuid,
    sentence character varying(1000),
    book_title character varying(500),
    stage integer NOT NULL,
    interval_days double precision NOT NULL,
    consecutive_correct integer NOT NULL,
    next_review_at timestamp with time zone NOT NULL,
    last_reviewed_at timestamp with time zone,
    total_reviews integer NOT NULL,
    correct_reviews integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    distractors text,
    hint character varying(500),
    explanation character varying(1000),
    activated_at timestamp with time zone,
    cluster_id uuid,
    is_retired boolean DEFAULT false NOT NULL,
    priority double precision DEFAULT 0.0 NOT NULL,
    retired_at timestamp with time zone,
    retired_reason character varying(60),
    source character varying(40) DEFAULT 'tap'::character varying NOT NULL,
    zipf_rank integer,
    zipf_score double precision,
    concept_cluster_id uuid,
    embedding public.vector(1536)
);
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT pk_vocabulary_words PRIMARY KEY (id);
CREATE INDEX ix_vocabulary_words_chapter_id ON public.vocabulary_words USING btree (chapter_id);
CREATE INDEX ix_vocabulary_words_cluster_id ON public.vocabulary_words USING btree (cluster_id);
CREATE INDEX ix_vocabulary_words_concept_cluster_id ON public.vocabulary_words USING btree (concept_cluster_id);
CREATE INDEX ix_vocabulary_words_edition_id ON public.vocabulary_words USING btree (edition_id);
CREATE INDEX ix_vocabulary_words_site_id ON public.vocabulary_words USING btree (site_id);
CREATE INDEX ix_vocabulary_words_user_book_id ON public.vocabulary_words USING btree (user_book_id);
CREATE INDEX ix_vocabulary_words_user_id_site_id ON public.vocabulary_words USING btree (user_id, site_id);
CREATE INDEX ix_vocabulary_words_user_id_site_id_is_retired_next_review_at ON public.vocabulary_words USING btree (user_id, site_id, is_retired, next_review_at);
CREATE UNIQUE INDEX ix_vocabulary_words_user_id_site_id_word_language ON public.vocabulary_words USING btree (user_id, site_id, word, language);

-- 51. vocabulary_reviews — Each review answer
CREATE TABLE public.vocabulary_reviews (
    id uuid NOT NULL,
    vocabulary_word_id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    review_mode character varying(30) NOT NULL,
    is_correct boolean NOT NULL,
    response_time_ms integer NOT NULL,
    stage_before integer NOT NULL,
    stage_after integer NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.vocabulary_reviews
    ADD CONSTRAINT pk_vocabulary_reviews PRIMARY KEY (id);
CREATE INDEX ix_vocabulary_reviews_site_id ON public.vocabulary_reviews USING btree (site_id);
CREATE INDEX ix_vocabulary_reviews_user_id_site_id_created_at ON public.vocabulary_reviews USING btree (user_id, site_id, created_at);
CREATE INDEX ix_vocabulary_reviews_vocabulary_word_id ON public.vocabulary_reviews USING btree (vocabulary_word_id);

-- 52. user_vocabulary_settings — Per-user vocabulary settings
CREATE TABLE public.user_vocabulary_settings (
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    daily_new_cap integer NOT NULL,
    weekly_review_budget integer NOT NULL,
    frequency_filter_enabled boolean NOT NULL,
    clustering_enabled boolean NOT NULL,
    auto_retire_enabled boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    auto_speak_cards boolean DEFAULT true NOT NULL
);
ALTER TABLE ONLY public.user_vocabulary_settings
    ADD CONSTRAINT pk_user_vocabulary_settings PRIMARY KEY (user_id, site_id);
CREATE INDEX ix_user_vocabulary_settings_site_id ON public.user_vocabulary_settings USING btree (site_id);

-- 53. pending_vocabulary_words — Saves over the daily cap
CREATE TABLE public.pending_vocabulary_words (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    word character varying(200) NOT NULL,
    language character varying(8) NOT NULL,
    translation character varying(500),
    definition character varying(2000),
    edition_id uuid,
    chapter_id uuid,
    user_book_id uuid,
    sentence character varying(1000),
    book_title character varying(500),
    zipf_rank integer,
    zipf_score double precision,
    priority double precision NOT NULL,
    source character varying(40) NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.pending_vocabulary_words
    ADD CONSTRAINT pk_pending_vocabulary_words PRIMARY KEY (id);
CREATE INDEX ix_pending_vocabulary_words_chapter_id ON public.pending_vocabulary_words USING btree (chapter_id);
CREATE INDEX ix_pending_vocabulary_words_edition_id ON public.pending_vocabulary_words USING btree (edition_id);
CREATE INDEX ix_pending_vocabulary_words_site_id ON public.pending_vocabulary_words USING btree (site_id);
CREATE INDEX ix_pending_vocabulary_words_user_book_id ON public.pending_vocabulary_words USING btree (user_book_id);
CREATE INDEX ix_pending_vocabulary_words_user_id_site_id_created_at ON public.pending_vocabulary_words USING btree (user_id, site_id, created_at);
CREATE INDEX ix_pending_vocabulary_words_user_id_site_id_priority ON public.pending_vocabulary_words USING btree (user_id, site_id, priority DESC);
CREATE UNIQUE INDEX ix_pending_vocabulary_words_user_id_site_id_word_language ON public.pending_vocabulary_words USING btree (user_id, site_id, word, language);

-- 54. word_lookups — Tapped rare words
CREATE TABLE public.word_lookups (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    word character varying(200) NOT NULL,
    language character varying(8) NOT NULL,
    zipf_rank integer,
    tap_count integer NOT NULL,
    sentence character varying(1000),
    book_title character varying(500),
    edition_id uuid,
    chapter_id uuid,
    user_book_id uuid,
    last_translation character varying(500),
    first_tapped_at timestamp with time zone NOT NULL,
    last_tapped_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.word_lookups
    ADD CONSTRAINT pk_word_lookups PRIMARY KEY (id);
CREATE INDEX ix_word_lookups_chapter_id ON public.word_lookups USING btree (chapter_id);
CREATE INDEX ix_word_lookups_edition_id ON public.word_lookups USING btree (edition_id);
CREATE INDEX ix_word_lookups_site_id ON public.word_lookups USING btree (site_id);
CREATE INDEX ix_word_lookups_user_book_id ON public.word_lookups USING btree (user_book_id);
CREATE INDEX ix_word_lookups_user_id_site_id_last_tapped_at ON public.word_lookups USING btree (user_id, site_id, last_tapped_at DESC);
CREATE UNIQUE INDEX ix_word_lookups_user_id_site_id_word_language ON public.word_lookups USING btree (user_id, site_id, word, language);

-- 55. word_frequencies — Zipf word frequencies
CREATE TABLE public.word_frequencies (
    id uuid NOT NULL,
    language character varying(8) NOT NULL,
    word character varying(200) NOT NULL,
    rank integer NOT NULL,
    zipf double precision NOT NULL,
    pos character varying(20)
);
ALTER TABLE ONLY public.word_frequencies
    ADD CONSTRAINT pk_word_frequencies PRIMARY KEY (id);
CREATE INDEX ix_word_frequencies_language_rank ON public.word_frequencies USING btree (language, rank);
CREATE UNIQUE INDEX ix_word_frequencies_language_word ON public.word_frequencies USING btree (language, word);

-- 56. word_clusters — Book and concept groups of saved words
CREATE TABLE public.word_clusters (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    title character varying(200) NOT NULL,
    theme character varying(100),
    edition_id uuid,
    user_book_id uuid,
    book_title character varying(500),
    member_count integer NOT NULL,
    cohesion_score double precision NOT NULL,
    is_confirmed boolean NOT NULL,
    is_dismissed boolean NOT NULL,
    dismissed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    kind character varying(16) DEFAULT 'book'::character varying NOT NULL
);
ALTER TABLE ONLY public.word_clusters
    ADD CONSTRAINT pk_word_clusters PRIMARY KEY (id);
CREATE INDEX ix_word_clusters_edition_id ON public.word_clusters USING btree (edition_id);
CREATE INDEX ix_word_clusters_site_id ON public.word_clusters USING btree (site_id);
CREATE INDEX ix_word_clusters_user_book_id ON public.word_clusters USING btree (user_book_id);
CREATE INDEX ix_word_clusters_user_id_site_id_is_dismissed_created_at ON public.word_clusters USING btree (user_id, site_id, is_dismissed, created_at DESC);

-- 57. tutor_session — Learning-tutor state between turns
CREATE TABLE public.tutor_session (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    site_id uuid NOT NULL,
    plan_json jsonb NOT NULL,
    status character varying(16) NOT NULL,
    turn_count integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    applied_word_ids_json jsonb
);
ALTER TABLE ONLY public.tutor_session
    ADD CONSTRAINT pk_tutor_session PRIMARY KEY (id);
CREATE INDEX ix_tutor_session_site_id ON public.tutor_session USING btree (site_id);
CREATE INDEX ix_tutor_session_user_id_status_updated_at ON public.tutor_session USING btree (user_id, status, updated_at);

-- =====================================================================
-- AI operations
-- =====================================================================

-- 58. llm_traces — LLM call traces (cost, latency, text)
CREATE TABLE public.llm_traces (
    id uuid NOT NULL,
    feature_tag character varying(64) NOT NULL,
    model_id character varying(128) NOT NULL,
    prompt_hash character varying(64) NOT NULL,
    system_prompt text,
    messages_json jsonb NOT NULL,
    response_text text,
    tool_calls_json jsonb,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_usd numeric(10,6) NOT NULL,
    latency_ms integer NOT NULL,
    user_id uuid,
    trace_parent_id uuid,
    error text,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.llm_traces
    ADD CONSTRAINT pk_llm_traces PRIMARY KEY (id);
CREATE INDEX ix_llm_traces_feature_tag_created_at ON public.llm_traces USING btree (feature_tag, created_at);
CREATE INDEX ix_llm_traces_user_id ON public.llm_traces USING btree (user_id) WHERE (user_id IS NOT NULL);

-- 59. agent_run — Agent run steps
CREATE TABLE public.agent_run (
    id uuid NOT NULL,
    agent character varying(64) NOT NULL,
    user_id uuid,
    edition_id uuid,
    goal text NOT NULL,
    status character varying(32) NOT NULL,
    output text,
    steps_json jsonb NOT NULL,
    iterations integer NOT NULL,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_usd numeric(10,6) NOT NULL,
    latency_ms integer NOT NULL,
    error text,
    created_at timestamp with time zone NOT NULL,
    confidence double precision,
    tool_calls_count integer DEFAULT 0 NOT NULL
);
ALTER TABLE ONLY public.agent_run
    ADD CONSTRAINT pk_agent_run PRIMARY KEY (id);
CREATE INDEX ix_agent_run_user_id_created_at ON public.agent_run USING btree (user_id, created_at) WHERE (user_id IS NOT NULL);

-- 60. shadow_runs — Primary vs shadow model comparisons
CREATE TABLE public.shadow_runs (
    id uuid NOT NULL,
    feature_tag character varying(64) NOT NULL,
    primary_model_id character varying(128) NOT NULL,
    shadow_model_id character varying(128) NOT NULL,
    primary_response text,
    shadow_response text,
    primary_latency_ms integer NOT NULL,
    shadow_latency_ms integer NOT NULL,
    primary_cost_usd numeric(10,6) NOT NULL,
    shadow_cost_usd numeric(10,6) NOT NULL,
    primary_tokens_in integer NOT NULL,
    primary_tokens_out integer NOT NULL,
    shadow_tokens_in integer NOT NULL,
    shadow_tokens_out integer NOT NULL,
    primary_trace_id uuid,
    shadow_trace_id uuid,
    prompt_hash character varying(64) NOT NULL,
    user_id uuid,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.shadow_runs
    ADD CONSTRAINT pk_shadow_runs PRIMARY KEY (id);
CREATE INDEX ix_shadow_runs_feature_tag_created_at ON public.shadow_runs USING btree (feature_tag, created_at);
CREATE INDEX ix_shadow_runs_user_id ON public.shadow_runs USING btree (user_id) WHERE (user_id IS NOT NULL);

-- 61. models — Model registry, live routing
CREATE TABLE public.models (
    id uuid NOT NULL,
    provider_key character varying(64) NOT NULL,
    model_id character varying(128) NOT NULL,
    feature_tag character varying(64) NOT NULL,
    status character varying(20) NOT NULL,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.models
    ADD CONSTRAINT pk_models PRIMARY KEY (id);
CREATE UNIQUE INDEX ix_models_feature_tag ON public.models USING btree (feature_tag) WHERE ((status)::text = 'Primary'::text);
CREATE UNIQUE INDEX ix_models_feature_tag_provider_key_model_id ON public.models USING btree (feature_tag, provider_key, model_id);
CREATE INDEX ix_models_feature_tag_status ON public.models USING btree (feature_tag, status);

-- 62. model_promotions — Promote/rollback history
CREATE TABLE public.model_promotions (
    id uuid NOT NULL,
    feature_tag character varying(64) NOT NULL,
    from_model_registration_id uuid,
    to_model_registration_id uuid NOT NULL,
    from_provider_key character varying(64),
    from_model_id character varying(128),
    to_provider_key character varying(64) NOT NULL,
    to_model_id character varying(128) NOT NULL,
    action character varying(20) NOT NULL,
    admin_user_id uuid,
    created_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.model_promotions
    ADD CONSTRAINT pk_model_promotions PRIMARY KEY (id);
CREATE INDEX ix_model_promotions_feature_tag_created_at ON public.model_promotions USING btree (feature_tag, created_at);

-- 63. eval_runs — Eval score history
CREATE TABLE public.eval_runs (
    id uuid NOT NULL,
    feature character varying(64) NOT NULL,
    model_id character varying(128) NOT NULL,
    judge_model_id character varying(128) NOT NULL,
    score numeric(6,3) NOT NULL,
    n integer NOT NULL,
    breakdown_json jsonb,
    git_sha character varying(64),
    created_at timestamp with time zone NOT NULL,
    run_type character varying(20) DEFAULT 'manual'::character varying NOT NULL
);
ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT pk_eval_runs PRIMARY KEY (id);
CREATE INDEX ix_eval_runs_feature_created_at ON public.eval_runs USING btree (feature, created_at);

-- =====================================================================
-- Foreign keys (after every table, so the order above is free)
-- =====================================================================

-- site_domains
ALTER TABLE ONLY public.site_domains
    ADD CONSTRAINT fk_site_domains_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;

-- works
ALTER TABLE ONLY public.works
    ADD CONSTRAINT fk_works_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;

--

-- editions
ALTER TABLE ONLY public.editions
    ADD CONSTRAINT fk_editions_editions_source_edition_id FOREIGN KEY (source_edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.editions
    ADD CONSTRAINT fk_editions_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.editions
    ADD CONSTRAINT fk_editions_works_work_id FOREIGN KEY (work_id) REFERENCES public.works(id) ON DELETE CASCADE;

-- chapters
ALTER TABLE ONLY public.chapters
    ADD CONSTRAINT fk_chapters_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;

-- authors
ALTER TABLE ONLY public.authors
    ADD CONSTRAINT fk_authors_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;

-- edition_authors
ALTER TABLE ONLY public.edition_authors
    ADD CONSTRAINT fk_edition_authors_authors_author_id FOREIGN KEY (author_id) REFERENCES public.authors(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.edition_authors
    ADD CONSTRAINT fk_edition_authors_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;

-- genres
ALTER TABLE ONLY public.genres
    ADD CONSTRAINT fk_genres_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;

-- edition_genres
ALTER TABLE ONLY public.edition_genres
    ADD CONSTRAINT fk_edition_genres_editions_editions_id FOREIGN KEY (editions_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.edition_genres
    ADD CONSTRAINT fk_edition_genres_genres_genres_id FOREIGN KEY (genres_id) REFERENCES public.genres(id) ON DELETE CASCADE;

-- book_files
ALTER TABLE ONLY public.book_files
    ADD CONSTRAINT fk_book_files_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;

-- book_assets
ALTER TABLE ONLY public.book_assets
    ADD CONSTRAINT fk_book_assets_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;

-- ingestion_jobs
ALTER TABLE ONLY public.ingestion_jobs
    ADD CONSTRAINT fk_ingestion_jobs_book_files_book_file_id FOREIGN KEY (book_file_id) REFERENCES public.book_files(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ingestion_jobs
    ADD CONSTRAINT fk_ingestion_jobs_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ingestion_jobs
    ADD CONSTRAINT fk_ingestion_jobs_editions_source_edition_id FOREIGN KEY (source_edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ingestion_jobs
    ADD CONSTRAINT fk_ingestion_jobs_works_work_id FOREIGN KEY (work_id) REFERENCES public.works(id) ON DELETE SET NULL;

-- lint_results
ALTER TABLE ONLY public.lint_results
    ADD CONSTRAINT fk_lint_results_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;

-- text_stack_imports
ALTER TABLE ONLY public.text_stack_imports
    ADD CONSTRAINT fk_text_stack_imports_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.text_stack_imports
    ADD CONSTRAINT fk_text_stack_imports_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;

-- auto_publish_jobs
ALTER TABLE ONLY public.auto_publish_jobs
    ADD CONSTRAINT fk_auto_publish_jobs_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.auto_publish_jobs
    ADD CONSTRAINT fk_auto_publish_jobs_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;

-- book_quality_jobs
ALTER TABLE ONLY public.book_quality_jobs
    ADD CONSTRAINT fk_book_quality_jobs_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.book_quality_jobs
    ADD CONSTRAINT fk_book_quality_jobs_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE;

-- ssg_rebuild_jobs
ALTER TABLE ONLY public.ssg_rebuild_jobs
    ADD CONSTRAINT fk_ssg_rebuild_jobs_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;

-- ssg_rebuild_results
ALTER TABLE ONLY public.ssg_rebuild_results
    ADD CONSTRAINT fk_ssg_rebuild_results_ssg_rebuild_jobs_job_id FOREIGN KEY (job_id) REFERENCES public.ssg_rebuild_jobs(id) ON DELETE CASCADE;

-- user_refresh_tokens
ALTER TABLE ONLY public.user_refresh_tokens
    ADD CONSTRAINT fk_user_refresh_tokens_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- admin_refresh_tokens
ALTER TABLE ONLY public.admin_refresh_tokens
    ADD CONSTRAINT fk_admin_refresh_tokens_admin_users_admin_user_id FOREIGN KEY (admin_user_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;

-- password_reset_tokens
ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT fk_password_reset_tokens_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- device_authorizations
ALTER TABLE ONLY public.device_authorizations
    ADD CONSTRAINT fk_device_authorizations_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- oauth_grants
ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT fk_oauth_grants_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- mcp_access_keys
ALTER TABLE ONLY public.mcp_access_keys
    ADD CONSTRAINT fk_mcp_access_keys_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.mcp_access_keys
    ADD CONSTRAINT fk_mcp_access_keys_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- user_books
ALTER TABLE ONLY public.user_books
    ADD CONSTRAINT fk_user_books_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- user_chapters
ALTER TABLE ONLY public.user_chapters
    ADD CONSTRAINT fk_user_chapters_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE;

-- user_book_files
ALTER TABLE ONLY public.user_book_files
    ADD CONSTRAINT fk_user_book_files_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE;

-- user_ingestion_jobs
ALTER TABLE ONLY public.user_ingestion_jobs
    ADD CONSTRAINT fk_user_ingestion_jobs_user_book_files_user_book_file_id FOREIGN KEY (user_book_file_id) REFERENCES public.user_book_files(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_ingestion_jobs
    ADD CONSTRAINT fk_user_ingestion_jobs_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE;

-- user_book_bookmarks
ALTER TABLE ONLY public.user_book_bookmarks
    ADD CONSTRAINT fk_user_book_bookmarks_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_book_bookmarks
    ADD CONSTRAINT fk_user_book_bookmarks_user_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.user_chapters(id) ON DELETE SET NULL;

-- user_libraries
ALTER TABLE ONLY public.user_libraries
    ADD CONSTRAINT fk_user_libraries_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_libraries
    ADD CONSTRAINT fk_user_libraries_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- collections
ALTER TABLE ONLY public.collections
    ADD CONSTRAINT fk_collections_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- book_collections
ALTER TABLE ONLY public.book_collections
    ADD CONSTRAINT fk_book_collections_collections_collection_id FOREIGN KEY (collection_id) REFERENCES public.collections(id) ON DELETE CASCADE;

-- reading_progresses
ALTER TABLE ONLY public.reading_progresses
    ADD CONSTRAINT fk_reading_progresses_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id);
ALTER TABLE ONLY public.reading_progresses
    ADD CONSTRAINT fk_reading_progresses_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.reading_progresses
    ADD CONSTRAINT fk_reading_progresses_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.reading_progresses
    ADD CONSTRAINT fk_reading_progresses_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- bookmarks
ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT fk_bookmarks_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id);
ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT fk_bookmarks_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT fk_bookmarks_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT fk_bookmarks_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- highlights
ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT fk_highlights_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT fk_highlights_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT fk_highlights_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT fk_highlights_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT fk_highlights_user_chapters_user_chapter_id FOREIGN KEY (user_chapter_id) REFERENCES public.user_chapters(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT fk_highlights_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- notes
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT fk_notes_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id);
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT fk_notes_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT fk_notes_highlights_highlight_id FOREIGN KEY (highlight_id) REFERENCES public.highlights(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT fk_notes_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT fk_notes_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- reading_sessions
ALTER TABLE ONLY public.reading_sessions
    ADD CONSTRAINT fk_reading_sessions_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.reading_sessions
    ADD CONSTRAINT fk_reading_sessions_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.reading_sessions
    ADD CONSTRAINT fk_reading_sessions_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.reading_sessions
    ADD CONSTRAINT fk_reading_sessions_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- reading_goals
ALTER TABLE ONLY public.reading_goals
    ADD CONSTRAINT fk_reading_goals_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.reading_goals
    ADD CONSTRAINT fk_reading_goals_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- user_achievements
ALTER TABLE ONLY public.user_achievements
    ADD CONSTRAINT fk_user_achievements_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.user_achievements
    ADD CONSTRAINT fk_user_achievements_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- book_insight
ALTER TABLE ONLY public.book_insight
    ADD CONSTRAINT fk_book_insight_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.book_insight
    ADD CONSTRAINT fk_book_insight_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.book_insight
    ADD CONSTRAINT fk_book_insight_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.book_insight
    ADD CONSTRAINT fk_book_insight_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- review_question
ALTER TABLE ONLY public.review_question
    ADD CONSTRAINT fk_review_question_book_insight_book_insight_id FOREIGN KEY (book_insight_id) REFERENCES public.book_insight(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_question
    ADD CONSTRAINT fk_review_question_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.review_question
    ADD CONSTRAINT fk_review_question_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- vocabulary_words
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT fk_vocabulary_words_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT fk_vocabulary_words_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT fk_vocabulary_words_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT fk_vocabulary_words_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT fk_vocabulary_words_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT fk_vocabulary_words_word_clusters_cluster_id FOREIGN KEY (cluster_id) REFERENCES public.word_clusters(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.vocabulary_words
    ADD CONSTRAINT fk_vocabulary_words_word_clusters_concept_cluster_id FOREIGN KEY (concept_cluster_id) REFERENCES public.word_clusters(id) ON DELETE SET NULL;

-- vocabulary_reviews
ALTER TABLE ONLY public.vocabulary_reviews
    ADD CONSTRAINT fk_vocabulary_reviews_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.vocabulary_reviews
    ADD CONSTRAINT fk_vocabulary_reviews_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vocabulary_reviews
    ADD CONSTRAINT fk_vocabulary_reviews_vocabulary_words_vocabulary_word_id FOREIGN KEY (vocabulary_word_id) REFERENCES public.vocabulary_words(id) ON DELETE CASCADE;

-- user_vocabulary_settings
ALTER TABLE ONLY public.user_vocabulary_settings
    ADD CONSTRAINT fk_user_vocabulary_settings_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.user_vocabulary_settings
    ADD CONSTRAINT fk_user_vocabulary_settings_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- pending_vocabulary_words
ALTER TABLE ONLY public.pending_vocabulary_words
    ADD CONSTRAINT fk_pending_vocabulary_words_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pending_vocabulary_words
    ADD CONSTRAINT fk_pending_vocabulary_words_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pending_vocabulary_words
    ADD CONSTRAINT fk_pending_vocabulary_words_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.pending_vocabulary_words
    ADD CONSTRAINT fk_pending_vocabulary_words_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pending_vocabulary_words
    ADD CONSTRAINT fk_pending_vocabulary_words_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- word_lookups
ALTER TABLE ONLY public.word_lookups
    ADD CONSTRAINT fk_word_lookups_chapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.word_lookups
    ADD CONSTRAINT fk_word_lookups_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.word_lookups
    ADD CONSTRAINT fk_word_lookups_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.word_lookups
    ADD CONSTRAINT fk_word_lookups_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.word_lookups
    ADD CONSTRAINT fk_word_lookups_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- word_clusters
ALTER TABLE ONLY public.word_clusters
    ADD CONSTRAINT fk_word_clusters_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.word_clusters
    ADD CONSTRAINT fk_word_clusters_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.word_clusters
    ADD CONSTRAINT fk_word_clusters_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.word_clusters
    ADD CONSTRAINT fk_word_clusters_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- tutor_session
ALTER TABLE ONLY public.tutor_session
    ADD CONSTRAINT fk_tutor_session_sites_site_id FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.tutor_session
    ADD CONSTRAINT fk_tutor_session_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- llm_traces
ALTER TABLE ONLY public.llm_traces
    ADD CONSTRAINT fk_llm_traces_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- agent_run
ALTER TABLE ONLY public.agent_run
    ADD CONSTRAINT fk_agent_run_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- shadow_runs
ALTER TABLE ONLY public.shadow_runs
    ADD CONSTRAINT fk_shadow_runs_users_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- =====================================================================
-- Seed rows
-- =====================================================================
-- What a fresh database needs to serve: the one site and its dev hosts, genres, SEO prompt
-- templates, the SEO poller's settings row, and four example books (e2e reads an English one).

-- admin_users
INSERT INTO public.sites (id, code, primary_domain, default_language, theme, ads_enabled, indexing_enabled, sitemap_enabled, features_json, created_at, updated_at) VALUES
	('11111111-1111-1111-1111-111111111111', 'general', 'general.localhost', 'en', 'general', false, false, true, '{}', '2026-10-27 01:13:35.385334+00', '2026-10-27 01:13:35.47543+00');

-- authors
INSERT INTO public.authors (id, site_id, slug, name, bio, photo_path, created_at, updated_at, indexable, seo_title, seo_description, canonical_override, seo_faqs_json, seo_relevance_text, seo_themes_json, seo_source, external_links_json) VALUES
	('ae317e0b-e8af-46e2-ad8d-9a37a3f0127c', '11111111-1111-1111-1111-111111111111', 'lesya-ukrainka', 'Lesya Ukrainka', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('54216769-9fd5-4477-8f96-4f0a5c531fac', '11111111-1111-1111-1111-111111111111', 'taras-shevchenko', 'Taras Shevchenko', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('ee4669a8-d590-4346-9eb3-6b280db7a92a', '11111111-1111-1111-1111-111111111111', 'леся-укра-нка', 'Леся Українка', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('8d68ade5-32a4-4b67-97b8-8b2dc2450f99', '11111111-1111-1111-1111-111111111111', 'тарас-шевченко', 'Тарас Шевченко', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('76edaa0a-3410-48de-b667-bb8865ef5354', '11111111-1111-1111-1111-111111111111', 'taras-shevchenko-uk', 'Тарас Шевченко', 'Український поет, художник та мислитель.', NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('ce7c084c-ebc4-4dec-9c99-40181f76a537', '11111111-1111-1111-1111-111111111111', 'lesya-ukrainka-uk', 'Леся Українка', 'Українська письменниця, поетеса та перекладачка.', NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('2b9d4227-c796-45da-a138-18df8dc9c172', '11111111-1111-1111-1111-111111111111', 'erich-gamma', 'Erich Gamma', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('09d359b5-d68b-49b7-b8f4-348d4f2e52ef', '11111111-1111-1111-1111-111111111111', 'erich-gamma-uk', 'Еріх Гамма', NULL, NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('e5825a8c-98aa-4e43-9427-231210fa54ac', '11111111-1111-1111-1111-111111111111', 'john-vlissides', 'John Vlissides', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('ce15d663-43f2-48d9-b031-3ad4963fc170', '11111111-1111-1111-1111-111111111111', 'john-vlissides-uk', 'Джон Вліссідес', NULL, NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('8dbb2bcc-8c76-4838-8f6f-3f3f6e2d0e03', '11111111-1111-1111-1111-111111111111', 'ralph-johnson', 'Ralph Johnson', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('ac4544bc-3104-4e9f-aa1e-699c6e854092', '11111111-1111-1111-1111-111111111111', 'ralph-johnson-uk', 'Ральф Джонсон', NULL, NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('23d1488b-8369-4183-9cec-ee4f8f66b4bd', '11111111-1111-1111-1111-111111111111', 'richard-helm', 'Richard Helm', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('3f484270-1ebc-4256-a7a4-34f3b67ef2a0', '11111111-1111-1111-1111-111111111111', 'richard-helm-uk', 'Річард Хелм', NULL, NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('8f1c6472-15d9-4d90-adaa-d905a99dc4c0', '11111111-1111-1111-1111-111111111111', 'robert-c-martin', 'Robert C. Martin', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('5e5be523-c8bd-4ac7-993f-d2c6e694fa1a', '11111111-1111-1111-1111-111111111111', 'robert-martin', 'Robert C. Martin', 'Software engineer known as Uncle Bob.', NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('94bda7ee-d129-49df-924e-b8d4a02ee96e', '11111111-1111-1111-1111-111111111111', 'robert-martin-uk', 'Роберт Мартін', 'Інженер-програміст, відомий як Дядько Боб.', NULL, '2026-10-27 01:13:35.609208+00', '2026-10-27 01:13:35.609208+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('770fce90-6fc6-410f-b499-cf8376683988', '11111111-1111-1111-1111-111111111111', 'джон-вл-сс-дес', 'Джон Вліссідес', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('3c8c2242-c2a0-4739-8cb9-6a6e87ccc818', '11111111-1111-1111-1111-111111111111', 'ер-х-гамма', 'Еріх Гамма', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('d96edb5a-c368-449f-8c15-68391eb62b06', '11111111-1111-1111-1111-111111111111', 'ральф-джонсон', 'Ральф Джонсон', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('5c5e4383-0a74-448a-a204-3fe1628e323f', '11111111-1111-1111-1111-111111111111', 'роберт-март-н', 'Роберт Мартін', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('827cb40d-18dc-45e3-8a13-77fab5d150a6', '11111111-1111-1111-1111-111111111111', 'р-чард-хелм', 'Річард Хелм', NULL, NULL, '2026-10-27 01:13:35.562647+00', '2026-10-27 01:13:35.562647+00', true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL);

-- works
INSERT INTO public.works (id, slug, created_at, site_id) VALUES
	('aaaaaaaa-0001-0001-0001-000000000001', 'kobzar', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111'),
	('aaaaaaaa-0002-0002-0002-000000000002', 'forest-song', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111'),
	('aaaaaaaa-0003-0003-0003-000000000003', 'clean-code', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111'),
	('aaaaaaaa-0004-0004-0004-000000000004', 'design-patterns', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111');

-- editions
INSERT INTO public.editions (id, work_id, language, slug, title, description, status, published_at, source_edition_id, cover_path, is_public_domain, created_at, updated_at, site_id, canonical_override, indexable, seo_description, seo_title, toc_json, seo_faqs_json, seo_relevance_text, seo_themes_json, seo_source, featured_rank) VALUES
	('bbbbbbbb-0003-0003-0003-000000000002', 'aaaaaaaa-0003-0003-0003-000000000003', 'en', 'clean-code', 'Clean Code', 'A Handbook of Agile Software Craftsmanship. Learn to write code that is easy to read, understand, and maintain.', 1, '2008-08-01 00:00:00+00', NULL, NULL, false, '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111', NULL, true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('bbbbbbbb-0004-0004-0004-000000000002', 'aaaaaaaa-0004-0004-0004-000000000004', 'en', 'design-patterns', 'Design Patterns', 'Elements of Reusable Object-Oriented Software. The classic Gang of Four book on software design patterns.', 1, '1994-10-01 00:00:00+00', NULL, NULL, false, '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111', NULL, true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('bbbbbbbb-0001-0001-0001-000000000002', 'aaaaaaaa-0001-0001-0001-000000000001', 'en', 'kobzar', 'The Kobzar', 'A collection of poems by Taras Shevchenko, a symbol of Ukrainian literature.', 1, '1840-01-01 00:00:00+00', NULL, NULL, true, '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111', NULL, true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL),
	('bbbbbbbb-0002-0002-0002-000000000002', 'aaaaaaaa-0002-0002-0002-000000000002', 'en', 'forest-song', 'Forest Song', 'A drama-fairy tale by Lesya Ukrainka about the love between a forest nymph and a peasant.', 1, '1911-01-01 00:00:00+00', NULL, NULL, true, '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', '11111111-1111-1111-1111-111111111111', NULL, true, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL);

-- auto_publish_jobs
INSERT INTO public.chapters (id, edition_id, chapter_number, slug, title, html, plain_text, word_count, search_vector, created_at, updated_at, original_chapter_number, part_number, total_parts, content_quality_score) VALUES
	('6649379a-9af8-4c6c-8f6b-13f7fe2963f7', 'bbbbbbbb-0001-0001-0001-000000000002', 1, 'my-thoughts', 'My Thoughts', '<h1>My Thoughts</h1><p>My thoughts, my thoughts,<br/>My woe is with you!<br/>Why have you settled on paper<br/>In mournful rows?</p>', 'My thoughts, my thoughts, My woe is with you! Why have you settled on paper In mournful rows?', 18, '''mourn'':17 ''paper'':15 ''row'':18 ''settl'':13 ''thought'':2,4 ''woe'':6', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL),
	('16cdbaea-26ab-4936-8c5c-e376cd952b5d', 'bbbbbbbb-0001-0001-0001-000000000002', 2, 'kateryna', 'Kateryna', '<h1>Kateryna</h1><p>Fall in love, dark-browed maidens,<br/>But not with Muscovites,<br/>For Muscovites are foreign folk,<br/>They will bring you only strife.</p>', 'Fall in love, dark-browed maidens, But not with Muscovites, For Muscovites are foreign folk, They will bring you only strife.', 20, '''bring'':19 ''brow'':6 ''dark'':5 ''dark-brow'':4 ''fall'':1 ''folk'':16 ''foreign'':15 ''love'':3 ''maiden'':7 ''muscovit'':11,13 ''strife'':22', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL),
	('33bd7303-7e6a-4dff-8d64-958902e59757', 'bbbbbbbb-0002-0002-0002-000000000002', 1, 'prologue', 'Prologue', '<h1>Prologue</h1><p>A forest in Volyn, in ancient times. In the middle of the forest is a small lake, surrounded by reeds and sedge. Water lilies float on the lake.</p>', 'A forest in Volyn, in ancient times. In the middle of the forest is a small lake, surrounded by reeds and sedge. Water lilies float on the lake.', 27, '''ancient'':6 ''float'':25 ''forest'':2,13 ''lake'':17,28 ''lili'':24 ''middl'':10 ''reed'':20 ''sedg'':22 ''small'':16 ''surround'':18 ''time'':7 ''volyn'':4 ''water'':23', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL),
	('209f970d-f785-4c3e-8758-f98371f2a265', 'bbbbbbbb-0002-0002-0002-000000000002', 2, 'act-one', 'Act One', '<h1>Act One</h1><p>MAVKA emerges from the lake. She shakes off the water that falls from her like silver scales.</p>', 'MAVKA emerges from the lake. She shakes off the water that falls from her like silver scales.', 17, '''emerg'':2 ''fall'':12 ''lake'':5 ''like'':15 ''mavka'':1 ''scale'':17 ''shake'':7 ''silver'':16 ''water'':10', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL),
	('3743e7b6-7c5a-4d4a-b080-06df08f0859b', 'bbbbbbbb-0003-0003-0003-000000000002', 1, 'clean-code', 'Clean Code', '<h1>Clean Code</h1><p>There Will Be Code. Code represents the details of the requirements. At some level those details cannot be ignored or abstracted.</p>', 'There Will Be Code. Code represents the details of the requirements. At some level those details cannot be ignored or abstracted.', 22, '''abstract'':21 ''cannot'':17 ''code'':4,5 ''detail'':8,16 ''ignor'':19 ''level'':14 ''repres'':6 ''requir'':11', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL),
	('43b12d1f-7aef-4645-a661-e4bc0239d2c7', 'bbbbbbbb-0003-0003-0003-000000000002', 2, 'meaningful-names', 'Meaningful Names', '<h1>Meaningful Names</h1><p>Use Intention-Revealing Names. The name of a variable, function, or class should answer all the big questions.</p>', 'Use Intention-Revealing Names. The name of a variable, function, or class should answer all the big questions.', 18, '''answer'':15 ''big'':18 ''class'':13 ''function'':11 ''intent'':3 ''intention-rev'':2 ''name'':5,7 ''question'':19 ''reveal'':4 ''use'':1 ''variabl'':10', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL),
	('b6fb37c7-eb08-4b47-bd65-7fe06ad8d6f4', 'bbbbbbbb-0004-0004-0004-000000000002', 1, 'introduction', 'Introduction', '<h1>Introduction</h1><p>Designing object-oriented software is hard, and designing reusable object-oriented software is even harder.</p>', 'Designing object-oriented software is hard, and designing reusable object-oriented software is even harder.', 15, '''design'':1,9 ''even'':16 ''hard'':7 ''harder'':17 ''object'':3,12 ''object-ori'':2,11 ''orient'':4,13 ''reusabl'':10 ''softwar'':5,14', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL),
	('aa9cf442-ecf3-452b-aef5-1d7a86dda4b9', 'bbbbbbbb-0004-0004-0004-000000000002', 2, 'singleton', 'Singleton', '<h1>Singleton</h1><p>Ensure a class only has one instance, and provide a global point of access to it.</p>', 'Ensure a class only has one instance, and provide a global point of access to it.', 16, '''access'':14 ''class'':3 ''ensur'':1 ''global'':11 ''instanc'':7 ''one'':6 ''point'':12 ''provid'':9', '2026-10-27 01:13:35.51064+00', '2026-10-27 01:13:35.51064+00', NULL, NULL, NULL, NULL);

-- bookmarks
INSERT INTO public.edition_authors (edition_id, author_id, "order", role) VALUES
	('bbbbbbbb-0001-0001-0001-000000000002', '54216769-9fd5-4477-8f96-4f0a5c531fac', 0, 'author'),
	('bbbbbbbb-0002-0002-0002-000000000002', 'ae317e0b-e8af-46e2-ad8d-9a37a3f0127c', 0, 'author'),
	('bbbbbbbb-0003-0003-0003-000000000002', '8f1c6472-15d9-4d90-adaa-d905a99dc4c0', 0, 'author'),
	('bbbbbbbb-0004-0004-0004-000000000002', '2b9d4227-c796-45da-a138-18df8dc9c172', 0, 'author'),
	('bbbbbbbb-0004-0004-0004-000000000002', '23d1488b-8369-4183-9cec-ee4f8f66b4bd', 1, 'author'),
	('bbbbbbbb-0004-0004-0004-000000000002', '8dbb2bcc-8c76-4838-8f6f-3f3f6e2d0e03', 2, 'author'),
	('bbbbbbbb-0004-0004-0004-000000000002', 'e5825a8c-98aa-4e43-9427-231210fa54ac', 3, 'author');

-- genres
INSERT INTO public.genres (id, site_id, slug, name, description, created_at, updated_at, indexable, seo_title, seo_description, seo_source) VALUES
	('6f4663a9-b030-4b1c-9e91-0d58e363c218', '11111111-1111-1111-1111-111111111111', 'poetry', 'Poetry', 'Poetic works and verse collections.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('c3249277-9b31-4578-9346-01cb5ad46d42', '11111111-1111-1111-1111-111111111111', 'drama', 'Drama', 'Theatrical plays and dramatic works.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('34381c8c-8ec1-4740-b1e2-c93b65cd2b21', '11111111-1111-1111-1111-111111111111', 'classic-literature', 'Classic Literature', 'Timeless literary masterpieces.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('2f4c3d4e-d4ce-4540-aa87-7e4d8bfdf07b', '11111111-1111-1111-1111-111111111111', 'ukrainian-literature', 'Ukrainian Literature', 'Works by Ukrainian authors.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('ae4c84f9-7d7f-40b5-85be-73942004c238', '11111111-1111-1111-1111-111111111111', 'fiction', 'Fiction', 'Imaginative and narrative prose works.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('5f5f67cf-d5f2-48df-9a62-dea65477dd36', '11111111-1111-1111-1111-111111111111', 'science-fiction', 'Science Fiction', 'Speculative fiction exploring futuristic concepts and technology.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('3202ce11-70f2-470b-b953-3d35d582c9da', '11111111-1111-1111-1111-111111111111', 'fantasy', 'Fantasy', 'Fiction featuring magical and supernatural elements.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('2d2a186e-57ed-42fc-aae9-00e62095ab97', '11111111-1111-1111-1111-111111111111', 'mystery', 'Mystery', 'Stories centered around solving crimes or puzzles.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('6991ce3b-b17a-4607-81ef-b22fc1f5f500', '11111111-1111-1111-1111-111111111111', 'thriller', 'Thriller', 'Suspenseful stories with tension and excitement.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('727025fc-5b7c-45ed-8d01-d16dbe3456c2', '11111111-1111-1111-1111-111111111111', 'romance', 'Romance', 'Stories focused on romantic relationships.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('e90fd974-3990-454d-9dcd-945b14fa56f4', '11111111-1111-1111-1111-111111111111', 'horror', 'Horror', 'Fiction designed to frighten and create suspense.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('8168912b-b75f-499a-b528-16dfc5f91d60', '11111111-1111-1111-1111-111111111111', 'adventure', 'Adventure', 'Exciting stories with journeys and explorations.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('1ca67386-33d5-4b4b-a367-ba82e531b3de', '11111111-1111-1111-1111-111111111111', 'historical-fiction', 'Historical Fiction', 'Fiction set in a specific historical period.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('e03b7d32-b65a-450f-9a3e-2e6a4e62fd5d', '11111111-1111-1111-1111-111111111111', 'detective', 'Detective', 'Crime fiction featuring investigation and detection.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('c382b81b-713a-4bbc-9761-01134508f7e0', '11111111-1111-1111-1111-111111111111', 'non-fiction', 'Non-Fiction', 'Factual prose works based on real events.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('ac3ee184-67e8-4814-a37d-ea3bff9e6304', '11111111-1111-1111-1111-111111111111', 'biography', 'Biography', 'Accounts of people''s lives written by others.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('b8d47ce8-0b3b-405d-8ced-eab526deddc6', '11111111-1111-1111-1111-111111111111', 'autobiography', 'Autobiography', 'Self-written accounts of one''s own life.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('3a454542-4b1b-43c1-86ca-c5ecbe7fb23e', '11111111-1111-1111-1111-111111111111', 'history', 'History', 'Non-fiction about past events and civilizations.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('8e64f74e-8ffc-42b5-b906-1860c80931bd', '11111111-1111-1111-1111-111111111111', 'science', 'Science', 'Books about scientific discoveries and concepts.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('bc71b9b0-85db-4aa5-82af-1b327253b26a', '11111111-1111-1111-1111-111111111111', 'philosophy', 'Philosophy', 'Exploration of fundamental questions about existence.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('4db87831-70cb-4c64-ba4e-78676829ead6', '11111111-1111-1111-1111-111111111111', 'psychology', 'Psychology', 'Study of mind, behavior and mental processes.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('7af4ffe6-7d00-423d-a005-9a0bdf8ae294', '11111111-1111-1111-1111-111111111111', 'self-help', 'Self-Help', 'Books for personal improvement and development.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('303d8efe-6f38-4932-a930-01b79a4df159', '11111111-1111-1111-1111-111111111111', 'business', 'Business', 'Books about commerce, entrepreneurship and management.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('0ad5f574-7899-4da3-b33c-2d5ceb3f04f8', '11111111-1111-1111-1111-111111111111', 'economics', 'Economics', 'Study of production, distribution and consumption.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('d84669b3-6a4a-4e18-a323-682cf90b829d', '11111111-1111-1111-1111-111111111111', 'children', 'Children''s Books', 'Books written for young readers.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('ea341b0f-c494-4ec7-b286-77e1089b9b30', '11111111-1111-1111-1111-111111111111', 'young-adult', 'Young Adult', 'Books for teenage readers.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('453bcf30-1abe-4543-bc81-7d12f965714c', '11111111-1111-1111-1111-111111111111', 'comics', 'Comics & Graphic Novels', 'Visual storytelling in comic format.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('afbfde53-af1e-4a59-a78d-551da9bfed15', '11111111-1111-1111-1111-111111111111', 'essays', 'Essays', 'Short literary compositions on various subjects.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('15aa5ea1-4b83-466d-a49d-f81e44787168', '11111111-1111-1111-1111-111111111111', 'travel', 'Travel', 'Books about journeys and destinations.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('c44cb946-3c80-4a97-ac32-33a7135b0a18', '11111111-1111-1111-1111-111111111111', 'art', 'Art & Photography', 'Books about visual arts and photography.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('85c03f30-2e66-4687-8ce3-108327a5e163', '11111111-1111-1111-1111-111111111111', 'cooking', 'Cooking & Food', 'Cookbooks and culinary literature.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('06d5f110-e4a1-4221-9b9f-18a0087185de', '11111111-1111-1111-1111-111111111111', 'religion', 'Religion & Spirituality', 'Books about faith and spiritual practices.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('590b4bc5-7994-4043-bd03-9120d227255c', '11111111-1111-1111-1111-111111111111', 'humor', 'Humor', 'Comedy and humorous writing.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('99428af0-55da-47d2-ba25-b9ede418a08e', '11111111-1111-1111-1111-111111111111', 'short-stories', 'Short Stories', 'Collections of brief fictional narratives.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('080a1e18-ff95-4580-8bb7-7003c7085c93', '11111111-1111-1111-1111-111111111111', 'algorithms', 'Algorithms & Data Structures', 'Fundamental CS algorithms and data structures.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('02f9d218-9240-4134-9111-04e2753ec4aa', '11111111-1111-1111-1111-111111111111', 'architecture', 'Software Architecture', 'System design and architectural patterns.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('e3fb4a87-514d-424d-8bef-1718a4b87bbb', '11111111-1111-1111-1111-111111111111', 'clean-code', 'Clean Code', 'Code quality, readability and maintainability.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('3b98bf4d-7ab1-4310-866b-c0c4e57ade18', '11111111-1111-1111-1111-111111111111', 'computer-science', 'Computer Science', 'Theoretical foundations of computing.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('d50f3dbf-74e8-4686-9c96-cd7f9a81d677', '11111111-1111-1111-1111-111111111111', 'databases', 'Databases', 'SQL, NoSQL and database design.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('ef97b84b-f856-4634-8124-fbc640777dd8', '11111111-1111-1111-1111-111111111111', 'design-patterns', 'Design Patterns', 'Software design patterns and architectural solutions.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('3393d668-3470-4fc0-bf88-80d93c47fd2b', '11111111-1111-1111-1111-111111111111', 'devops', 'DevOps', 'CI/CD, infrastructure and deployment.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('ca4e3ffd-70af-43b5-8cde-7322928bca27', '11111111-1111-1111-1111-111111111111', 'machine-learning', 'Machine Learning & AI', 'Artificial intelligence and ML algorithms.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('9aa00820-1efd-475f-8cf8-70f44bc28896', '11111111-1111-1111-1111-111111111111', 'mobile-development', 'Mobile Development', 'iOS, Android and cross-platform app development.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('fd907960-d0cc-47b7-a7c2-8a40a5a93d69', '11111111-1111-1111-1111-111111111111', 'networking', 'Networking', 'Computer networks and protocols.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('acb12f89-f5b7-48cf-8cec-c125cf3efca8', '11111111-1111-1111-1111-111111111111', 'object-oriented-programming', 'Object-Oriented Programming', 'OOP concepts and best practices.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('2d2ff12b-a677-4edb-8feb-541972297e3e', '11111111-1111-1111-1111-111111111111', 'security', 'Security', 'Cybersecurity and secure coding practices.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('3c4d8cb4-e9ac-49c0-83f1-4e28ce806f7b', '11111111-1111-1111-1111-111111111111', 'software-development', 'Software Development', 'General software engineering and development practices.', '2026-10-27 01:13:35.631114+00', '2026-10-27 01:13:35.631114+00', true, NULL, NULL, 0),
	('62c9b063-8670-4b64-857d-c7a319d1c561', '11111111-1111-1111-1111-111111111111', 'testing', 'Testing & QA', 'Software testing and quality assurance.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0),
	('efad7537-8413-47ff-9433-a56deff46b90', '11111111-1111-1111-1111-111111111111', 'web-development', 'Web Development', 'Frontend, backend and full-stack web technologies.', '2026-10-27 01:13:35.651915+00', '2026-10-27 01:13:35.651915+00', true, NULL, NULL, 0);

-- edition_genres
INSERT INTO public.edition_genres (editions_id, genres_id) VALUES
	('bbbbbbbb-0001-0001-0001-000000000002', '6f4663a9-b030-4b1c-9e91-0d58e363c218'),
	('bbbbbbbb-0001-0001-0001-000000000002', '34381c8c-8ec1-4740-b1e2-c93b65cd2b21'),
	('bbbbbbbb-0001-0001-0001-000000000002', '2f4c3d4e-d4ce-4540-aa87-7e4d8bfdf07b'),
	('bbbbbbbb-0002-0002-0002-000000000002', 'c3249277-9b31-4578-9346-01cb5ad46d42'),
	('bbbbbbbb-0002-0002-0002-000000000002', '34381c8c-8ec1-4740-b1e2-c93b65cd2b21'),
	('bbbbbbbb-0002-0002-0002-000000000002', '2f4c3d4e-d4ce-4540-aa87-7e4d8bfdf07b'),
	('bbbbbbbb-0003-0003-0003-000000000002', '3c4d8cb4-e9ac-49c0-83f1-4e28ce806f7b'),
	('bbbbbbbb-0003-0003-0003-000000000002', 'e3fb4a87-514d-424d-8bef-1718a4b87bbb'),
	('bbbbbbbb-0004-0004-0004-000000000002', '3c4d8cb4-e9ac-49c0-83f1-4e28ce806f7b'),
	('bbbbbbbb-0004-0004-0004-000000000002', 'ef97b84b-f856-4634-8124-fbc640777dd8'),
	('bbbbbbbb-0004-0004-0004-000000000002', 'acb12f89-f5b7-48cf-8cec-c125cf3efca8');

-- eval_runs
INSERT INTO public.seo_backfill_settings (id, enabled, jobs_per_run, interval_seconds, language_filter, entity_type_filter, ssg_rebuild_batch_minutes, updated_at) VALUES
	('44444444-4444-4444-4444-444444444444', false, 5, 60, '{}', '{}', 5, '2026-10-27 01:13:36.834608+00');

-- seo_templates
INSERT INTO public.seo_templates (id, entity_type, field_type, language_code, name, description, prompt_template, output_schema, model, max_tokens, temperature, trust_level, version, is_active, created_at, updated_at) VALUES
	('aaaaaaaa-0001-0000-0000-000000000001', 0, 0, 'en', 'Author Bio (EN)', '200-400 word encyclopedic biography covering life, works, style, influence.', 'You are an SEO content writer for TextStack, a free online book library.

Generate a biography for this author. Write in the SAME LANGUAGE indicated below.

Author: {name}
Published books on TextStack: {books}
Language: {language}

Rules:
- Factual, encyclopedic tone
- Include birth/death years if known
- Mention major works and achievements
- No subjective superlatives
- 200-400 words
- Write in language: {language}

Output ONLY valid JSON:
{"bio": "[200-400 word biography covering life, major works, literary style, influence]"}', '{"type": "object", "required": ["bio"], "properties": {"bio": {"type": "string", "maxLength": 5000, "minLength": 500}}}', 'claude-sonnet-4-6', 4096, 0.7, 1, 1, true, '2026-10-27 01:13:36.834608+00', '2026-10-27 01:13:36.834608+00'),
	('aaaaaaaa-0002-0000-0000-000000000001', 1, 1, 'en', 'Edition Description (EN)', '150-250 word plot summary + literary significance.', 'You are an SEO content writer for TextStack, a free online book library.

Generate a plot description for this book. Write in the SAME LANGUAGE as the book.

Book: {title}
Author: {author}
Language: {language}
First chapter excerpt: {excerpt}

Rules:
- Factual, encyclopedic tone
- No subjective superlatives
- 150-250 words
- Combine plot summary + literary significance
- Write in language: {language}

Output ONLY valid JSON:
{"description": "[150-250 word plot summary and literary significance]"}', '{"type": "object", "required": ["description"], "properties": {"description": {"type": "string", "maxLength": 3000, "minLength": 400}}}', 'claude-sonnet-4-6', 4096, 0.7, 1, 1, true, '2026-10-27 01:13:36.834608+00', '2026-10-27 01:13:36.834608+00'),
	('aaaaaaaa-0003-0000-0000-000000000001', 1, 2, 'en', 'Edition Relevance (EN)', '100-150 words: modern connections, cultural influence.', 'You are an SEO content writer for TextStack, a free online book library.

Explain why this book is still relevant today. Write in the SAME LANGUAGE as the book.

Book: {title}
Author: {author}
Language: {language}

Rules:
- Factual, encyclopedic tone
- 100-150 words
- Modern connections, cultural influence, why readers today should care
- Write in language: {language}

Output ONLY valid JSON:
{"relevance": "[100-150 word relevance essay]"}', '{"type": "object", "required": ["relevance"], "properties": {"relevance": {"type": "string", "maxLength": 2000, "minLength": 300}}}', 'claude-sonnet-4-6', 2048, 0.7, 1, 1, true, '2026-10-27 01:13:36.834608+00', '2026-10-27 01:13:36.834608+00'),
	('aaaaaaaa-0004-0000-0000-000000000001', 1, 3, 'en', 'Edition Themes (EN)', '5-7 noun-phrase themes for the book.', 'You are an SEO content writer for TextStack, a free online book library.

Extract the main themes of this book. Write in the SAME LANGUAGE as the book.

Book: {title}
Author: {author}
Language: {language}

Rules:
- 5-7 themes
- Noun phrases only (e.g. "Guilt and redemption" not "Explores guilt")
- Write in language: {language}

Output ONLY valid JSON:
{"themes": ["Theme 1", "Theme 2", "Theme 3", "Theme 4", "Theme 5"]}', '{"type": "object", "required": ["themes"], "properties": {"themes": {"type": "array", "items": {"type": "string", "maxLength": 100, "minLength": 3}, "maxItems": 10, "minItems": 3}}}', 'claude-sonnet-4-6', 1024, 0.7, 1, 1, true, '2026-10-27 01:13:36.834608+00', '2026-10-27 01:13:36.834608+00'),
	('aaaaaaaa-0005-0000-0000-000000000001', 0, 5, 'en', 'Author SEO Title (EN)', '50–70 char page title for author page.', 'Generate an SEO page title for an author page.

Author: {name}
Language: {language}

Rules:
- 50–70 characters
- Include author name
- End with " | TextStack Reader"
- Plain text, no markdown

Output ONLY valid JSON:
{"seoTitle": "Author Name – Free Books to Read Online | TextStack Reader"}', '{"type": "object", "required": ["seoTitle"], "properties": {"seoTitle": {"type": "string", "maxLength": 120, "minLength": 20}}}', 'claude-sonnet-4-6', 256, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00'),
	('aaaaaaaa-0006-0000-0000-000000000001', 0, 6, 'en', 'Author SEO Description (EN)', '140–160 char meta description.', 'Generate a meta description for an author page.

Author: {name}
Books: {books}
Language: {language}

Rules:
- 140–160 characters
- Summarize author''s work; mention 1–2 flagship books
- Call-to-action-ish, natural prose
- Plain text, no markdown

Output ONLY valid JSON:
{"seoDescription": "Read free books by {Author Name} online — {short summary}. Start reading now on TextStack."}', '{"type": "object", "required": ["seoDescription"], "properties": {"seoDescription": {"type": "string", "maxLength": 300, "minLength": 80}}}', 'claude-sonnet-4-6', 512, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00'),
	('aaaaaaaa-0007-0000-0000-000000000001', 1, 5, 'en', 'Edition SEO Title (EN)', '50–70 char page title for book page.', 'Generate an SEO page title for a book page.

Book: {title}
Author: {author}
Language: {language}

Rules:
- 50–70 characters
- Include book title + author
- End with " | TextStack Reader"
- Plain text, no markdown

Output ONLY valid JSON:
{"seoTitle": "Book Title by Author – Read Free | TextStack Reader"}', '{"type": "object", "required": ["seoTitle"], "properties": {"seoTitle": {"type": "string", "maxLength": 120, "minLength": 20}}}', 'claude-sonnet-4-6', 256, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00'),
	('aaaaaaaa-0008-0000-0000-000000000001', 1, 6, 'en', 'Edition SEO Description (EN)', '140–160 char meta description.', 'Generate a meta description for a book page.

Book: {title}
Author: {author}
Language: {language}
Excerpt: {excerpt}

Rules:
- 140–160 characters
- Hook the reader, hint at theme
- No spoilers
- Plain text, no markdown

Output ONLY valid JSON:
{"seoDescription": "Read {title} by {author} free online — {hook}. Start reading on TextStack."}', '{"type": "object", "required": ["seoDescription"], "properties": {"seoDescription": {"type": "string", "maxLength": 300, "minLength": 80}}}', 'claude-sonnet-4-6', 512, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00'),
	('aaaaaaaa-0009-0000-0000-000000000001', 1, 4, 'en', 'Edition FAQs (EN)', '3–5 Q/A pairs for book page.', 'Generate FAQ questions and answers for a book page.

Book: {title}
Author: {author}
Language: {language}
Excerpt: {excerpt}

Rules:
- 3–5 Q/A pairs
- Questions readers actually ask (who is the author, what''s it about, is it free, reading time, difficulty)
- Short answers, 1–3 sentences
- Write in language: {language}

Output ONLY valid JSON:
{"faqs": [{"question": "...", "answer": "..."}, ...]}', '{"type": "object", "required": ["faqs"], "properties": {"faqs": {"type": "array", "items": {"type": "object", "required": ["question", "answer"], "properties": {"answer": {"type": "string", "maxLength": 1000, "minLength": 10}, "question": {"type": "string", "maxLength": 300, "minLength": 5}}}, "maxItems": 8, "minItems": 3}}}', 'claude-sonnet-4-6', 2048, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00'),
	('aaaaaaaa-0010-0000-0000-000000000001', 2, 1, 'en', 'Genre Description (EN)', '150–250 word genre overview.', 'Generate an SEO description for a book genre page.

Genre: {name}
Example books: {books}

Rules:
- 150–250 words, English
- What defines this genre (themes, conventions)
- Why readers love it
- Mention notable works if provided
- Factual, encyclopedic tone

Output ONLY valid JSON:
{"description": "[150–250 word genre overview]"}', '{"type": "object", "required": ["description"], "properties": {"description": {"type": "string", "maxLength": 3000, "minLength": 400}}}', 'claude-sonnet-4-6', 2048, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00'),
	('aaaaaaaa-0011-0000-0000-000000000001', 2, 5, 'en', 'Genre SEO Title (EN)', '50–70 char page title.', 'Generate an SEO title for a genre page.

Genre: {name}

Rules:
- 50–70 characters
- Highlight "free books"
- End with " | TextStack Reader"

Output ONLY valid JSON:
{"seoTitle": "{Genre} Books – Read Free Online | TextStack Reader"}', '{"type": "object", "required": ["seoTitle"], "properties": {"seoTitle": {"type": "string", "maxLength": 120, "minLength": 20}}}', 'claude-sonnet-4-6', 256, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00'),
	('aaaaaaaa-0012-0000-0000-000000000001', 2, 6, 'en', 'Genre SEO Description (EN)', '140–160 char meta description.', 'Generate a meta description for a genre page.

Genre: {name}
Example books: {books}

Rules:
- 140–160 characters
- Hook readers, mention 1 flagship title if available
- Plain text, no markdown

Output ONLY valid JSON:
{"seoDescription": "Browse free {genre} books online — classics and hidden gems. Start reading on TextStack."}', '{"type": "object", "required": ["seoDescription"], "properties": {"seoDescription": {"type": "string", "maxLength": 300, "minLength": 80}}}', 'claude-sonnet-4-6', 512, 0.7, 1, 1, true, '2026-10-27 01:13:36.900028+00', '2026-10-27 01:13:36.900028+00');

-- shadow_runs
INSERT INTO public.site_domains (id, site_id, domain, is_primary, created_at) VALUES
	('97a8178c-46e2-46b9-a6ec-1d8f155645fc', '11111111-1111-1111-1111-111111111111', 'localhost', false, '2026-10-27 01:13:35.385334+00'),
	('c012b140-b31c-4389-ab91-d1e6857dd88a', '11111111-1111-1111-1111-111111111111', 'general.localhost', true, '2026-10-27 01:13:35.385334+00');
