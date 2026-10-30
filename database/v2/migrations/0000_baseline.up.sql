-- 0000_baseline — the V2 schema
--
-- What:  every table of textstack_v2, grouped by owner module: Identity, Library, Reading,
--          Annotations, Vocabulary, Discussion, Ops, and two Transitional tables (book_chapters,
--          ingestion_jobs) that are dropped at M6.4. 24 permanent + 2 transitional (ADR-031).
--          No seed rows.
-- Why:   V2 lives in its own database (ADR-030) whose baseline is the final schema: read it top to
--          bottom to know V2's data. Rules: database/v2/README.md.
-- Issue: https://github.com/mrviduus/textstack/issues/1014
-- Compatibility: a new, empty database. Nothing deployed reads or writes it yet; the api
--                and the worker get a connection to it in M1.2.
-- Down:  none. To start over, drop textstack_v2; migrator-v2 creates it again.

-- A locator is an envelope {"version":1,"scheme":…,"value":…}; an epub-cfi locator may carry the
-- first 1-64 characters of text at the CFI as "quote" (an empty one would make every resume check
-- pass). Only the envelope is checked here: the application validates the value against the book
-- (ADR-031 "Locator schemes"). SQL NULL passes, so a nullable locator column needs no OR IS NULL.
CREATE FUNCTION public.is_locator(locator jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    RETURN jsonb_typeof(locator) = 'object'
        AND locator -> 'version' = '1'
        AND locator ->> 'scheme' IN ('epub-cfi', 'pdf-page', 'textstack-position-v1', 'textstack-anchor-v1')
        -- A missing value, or an explicit null: neither is a position.
        AND locator ? 'value'
        AND jsonb_typeof(locator -> 'value') <> 'null'
        AND (NOT locator ? 'quote'
             OR (locator ->> 'scheme' = 'epub-cfi'
                 AND jsonb_typeof(locator -> 'quote') = 'string'
                 AND length(locator ->> 'quote') BETWEEN 1 AND 64));

-- ===== Identity =====

-- An account: a reader, a guest (ADR-014) or staff (role). Deleting it deletes everything the
-- account owns: every user-owned table cascades from here (ADR-031 rule 9).
CREATE TABLE public.users (
    id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    -- No '' defaults (legacy has them, unused): with the unique indexes below, a second insert
    -- that omitted email or google_subject would collide on ''.
    email varchar(255) NOT NULL,
    google_subject varchar(255),
    name varchar(255),
    picture text,
    storage_used_bytes bigint NOT NULL DEFAULT 0,
    apple_subject varchar(255),
    password_hash varchar(255),
    is_guest boolean NOT NULL DEFAULT false,
    last_active_at timestamptz,
    native_language varchar(16),
    storage_limit_override_bytes bigint,
    tier varchar(20) NOT NULL DEFAULT 'Free',
    promoted_at timestamptz,
    role text NOT NULL DEFAULT 'reader',
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT ck_users_role CHECK (role IN ('reader', 'admin')),
    CONSTRAINT ck_users_tier CHECK (tier IN ('Guest', 'Free', 'Supporter', 'Staff'))
);
CREATE UNIQUE INDEX ix_users_email ON public.users (lower(email));
CREATE UNIQUE INDEX ix_users_google_subject ON public.users (google_subject) WHERE google_subject IS NOT NULL;
CREATE UNIQUE INDEX ix_users_apple_subject ON public.users (apple_subject) WHERE apple_subject IS NOT NULL;
-- The guest sweeper's scan: inactive guests.
CREATE INDEX ix_users_guest_cleanup ON public.users (is_guest, last_active_at) WHERE is_guest;
COMMENT ON TABLE public.users IS
    'Identity. An account: reader, guest (ADR-014) or admin (role). Deleting it cascades to every row the account owns.';

-- A signed-in session, readers' and admins' alike. previous_token_hash detects a reused refresh token.
CREATE TABLE public.user_refresh_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    previous_token_hash text,
    CONSTRAINT pk_user_refresh_tokens PRIMARY KEY (id),
    CONSTRAINT fk_user_refresh_tokens_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_user_refresh_tokens_token_hash ON public.user_refresh_tokens (token_hash);
CREATE INDEX ix_user_refresh_tokens_previous_token_hash ON public.user_refresh_tokens (previous_token_hash);
CREATE INDEX ix_user_refresh_tokens_user_id ON public.user_refresh_tokens (user_id);
CREATE INDEX ix_user_refresh_tokens_expires_at ON public.user_refresh_tokens (expires_at);
COMMENT ON TABLE public.user_refresh_tokens IS
    'Identity. A session (refresh token) of a reader or an admin; deleted when it expires or is revoked.';

-- A reset code, stored hashed; used marks it spent.
CREATE TABLE public.password_reset_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash varchar(128) NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    used boolean NOT NULL,
    CONSTRAINT pk_password_reset_tokens PRIMARY KEY (id),
    CONSTRAINT fk_password_reset_tokens_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_password_reset_tokens_token_hash ON public.password_reset_tokens (token_hash);
CREATE INDEX ix_password_reset_tokens_user_id ON public.password_reset_tokens (user_id);
COMMENT ON TABLE public.password_reset_tokens IS
    'Identity. A password reset code; single use, short-lived.';

-- Not user-owned: a client registers once (ADR-017) and serves every user who connects it.
CREATE TABLE public.oauth_clients (
    id uuid NOT NULL,
    client_id varchar(512) NOT NULL,
    client_name varchar(100) NOT NULL,
    redirect_uris text[] NOT NULL,
    is_metadata_document boolean NOT NULL,
    created_at timestamptz NOT NULL,
    fetched_at timestamptz,
    CONSTRAINT pk_oauth_clients PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_oauth_clients_client_id ON public.oauth_clients (client_id);
COMMENT ON TABLE public.oauth_clients IS
    'Identity. A registered MCP OAuth client (ADR-017); shared by all users.';

-- user_id is set when the user approves; the request then dies with the account.
CREATE TABLE public.oauth_authorization_requests (
    id uuid NOT NULL,
    client_id varchar(512) NOT NULL,
    client_name varchar(100) NOT NULL,
    redirect_uri varchar(2048) NOT NULL,
    state varchar(1024),
    code_challenge varchar(128) NOT NULL,
    resource varchar(512) NOT NULL,
    scope varchar(200) NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    user_id uuid,
    code_hash varchar(128),
    denied_at timestamptz,
    consumed_at timestamptz,
    CONSTRAINT pk_oauth_authorization_requests PRIMARY KEY (id),
    CONSTRAINT fk_oauth_authorization_requests_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_oauth_authorization_requests_code_hash ON public.oauth_authorization_requests (code_hash);
CREATE INDEX ix_oauth_authorization_requests_created_at ON public.oauth_authorization_requests (created_at);
COMMENT ON TABLE public.oauth_authorization_requests IS
    'Identity. A pending MCP OAuth authorization (PKCE), until its code is exchanged, denied or expires.';

-- What an MCP client holds after the OAuth exchange; previous_refresh_token_hash detects reuse.
CREATE TABLE public.oauth_grants (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id varchar(512) NOT NULL,
    client_name varchar(100) NOT NULL,
    redirect_uri varchar(2048) NOT NULL,
    resource varchar(512) NOT NULL,
    scope varchar(200) NOT NULL,
    access_token_hash varchar(128) NOT NULL,
    access_token_expires_at timestamptz NOT NULL,
    refresh_token_hash varchar(128) NOT NULL,
    refresh_token_expires_at timestamptz NOT NULL,
    previous_refresh_token_hash varchar(128),
    created_at timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT pk_oauth_grants PRIMARY KEY (id),
    CONSTRAINT fk_oauth_grants_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_oauth_grants_access_token_hash ON public.oauth_grants (access_token_hash);
CREATE UNIQUE INDEX ix_oauth_grants_refresh_token_hash ON public.oauth_grants (refresh_token_hash);
CREATE INDEX ix_oauth_grants_previous_refresh_token_hash ON public.oauth_grants (previous_refresh_token_hash);
CREATE INDEX ix_oauth_grants_user_id ON public.oauth_grants (user_id);
COMMENT ON TABLE public.oauth_grants IS
    'Identity. An MCP OAuth token pair: one connected client of one user, until revoked.';

-- user_id is set when the user enters the code.
CREATE TABLE public.device_authorizations (
    id uuid NOT NULL,
    device_code_hash varchar(128) NOT NULL,
    user_code varchar(16) NOT NULL,
    user_id uuid,
    status varchar(16) NOT NULL,
    expires_at timestamptz NOT NULL,
    interval_seconds integer NOT NULL,
    created_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CONSTRAINT pk_device_authorizations PRIMARY KEY (id),
    CONSTRAINT ck_device_authorizations_status
        CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    CONSTRAINT fk_device_authorizations_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_device_authorizations_device_code_hash ON public.device_authorizations (device_code_hash);
-- Code entry looks up only attempts still waiting for it.
CREATE INDEX ix_device_authorizations_user_code ON public.device_authorizations (user_code) WHERE status = 'pending';
CREATE INDEX ix_device_authorizations_user_id ON public.device_authorizations (user_id);
CREATE INDEX ix_device_authorizations_expires_at ON public.device_authorizations (expires_at);
COMMENT ON TABLE public.device_authorizations IS
    'Identity. A device-flow login attempt, polled by the device until approved or expired.';

-- A connect key, stored hashed; prefix is the part the user sees to tell keys apart.
CREATE TABLE public.mcp_access_keys (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name varchar(60) NOT NULL,
    key_hash varchar(128) NOT NULL,
    prefix varchar(16) NOT NULL,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT pk_mcp_access_keys PRIMARY KEY (id),
    CONSTRAINT fk_mcp_access_keys_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_mcp_access_keys_key_hash ON public.mcp_access_keys (key_hash);
CREATE INDEX ix_mcp_access_keys_user_id ON public.mcp_access_keys (user_id);
COMMENT ON TABLE public.mcp_access_keys IS
    'Identity. A tsk_… MCP connect key; kept beside oauth_grants until explicitly retired (ADR-031).';

-- ===== Library =====

-- Its id survives renames and file replacement. Removal sets removed_at and keeps the row, so its
-- quotations, shares and checkpoints keep their provenance. A catalog book (D5) has no file yet.
CREATE TABLE public.books (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    author text,
    language text,
    description text,
    genre text,
    published_year integer,
    tags text[] NOT NULL DEFAULT '{}',
    cover_key text,
    -- Hidden provenance: {"kind":"upload"} | {"kind":"catalog","editionSlug":…} | {"kind":"clip","sourceUrl":…}.
    origin jsonb NOT NULL DEFAULT '{}',
    checkpoint_saving_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    CONSTRAINT pk_books PRIMARY KEY (id),
    -- The target of every (user_id, book_id) FK: a row cannot point at another user's book.
    CONSTRAINT ak_books_user_id_id UNIQUE (user_id, id),
    CONSTRAINT ck_books_title CHECK (btrim(title) <> ''),
    -- Blank is refused here; that it is a relative key on the volume, not a path, is the writer's job.
    CONSTRAINT ck_books_cover_key CHECK (cover_key IS NULL OR btrim(cover_key) <> ''),
    CONSTRAINT ck_books_origin CHECK (jsonb_typeof(origin) = 'object'),
    CONSTRAINT fk_books_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
COMMENT ON TABLE public.books IS
    'Library. A library entry of one user: an upload, a clip, or a catalog book with no file yet. Removal sets removed_at.';

-- A row does not imply server bytes exist; a device path never belongs here. After a replacement
-- only the current version keeps bytes; old rows stay as annotation provenance, and an old
-- server_storage_key is cleared only once its file is deleted.
CREATE TABLE public.book_files (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    sha256 text NOT NULL,
    byte_size bigint NOT NULL,
    original_name text NOT NULL,
    format text NOT NULL,
    page_count integer,
    toc jsonb,
    server_storage_key text,
    is_current boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_book_files PRIMARY KEY (id),
    CONSTRAINT ak_book_files_user_id_book_id_id UNIQUE (user_id, book_id, id),
    CONSTRAINT ak_book_files_user_id_book_id_sha256 UNIQUE (user_id, book_id, sha256),
    CONSTRAINT ck_book_files_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_book_files_byte_size CHECK (byte_size > 0),
    CONSTRAINT ck_book_files_original_name CHECK (btrim(original_name) <> ''),
    -- html = a clipped web page.
    CONSTRAINT ck_book_files_format CHECK (format IN ('epub', 'pdf', 'html')),
    CONSTRAINT ck_book_files_server_storage_key CHECK (server_storage_key IS NULL OR btrim(server_storage_key) <> ''),
    CONSTRAINT fk_book_files_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE
);
-- One current version per book.
CREATE UNIQUE INDEX ix_book_files_user_id_book_id ON public.book_files (user_id, book_id) WHERE is_current;
-- Duplicate detection is owner-scoped. No owner-wide UNIQUE: two library entries, or an archived
-- version, may hold the same bytes until an import policy says otherwise.
CREATE INDEX ix_book_files_user_id_sha256 ON public.book_files (user_id, sha256);
COMMENT ON TABLE public.book_files IS
    'Library. One exact file version (epub, pdf or html clip) of a book; at most one is current.';

-- ===== Reading =====

-- Position and frontier (furthest point reached) differ: moving back does not lower the frontier.
-- CFIs do not sort, so each locator has a fraction beside it, comparable only within one file
-- version; replacing the file resets the state. A stale revision is refused (409).
CREATE TABLE public.reading_state (
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid NOT NULL,
    current_locator jsonb NOT NULL,
    book_fraction numeric NOT NULL,
    frontier_locator jsonb,
    frontier_fraction numeric,
    completed_at timestamptz,
    client_recorded_at timestamptz NOT NULL,
    -- When the server accepted the state.
    updated_at timestamptz NOT NULL DEFAULT now(),
    revision bigint NOT NULL DEFAULT 1,
    CONSTRAINT pk_reading_state PRIMARY KEY (user_id, book_id),
    CONSTRAINT ck_reading_state_current_locator CHECK (public.is_locator(current_locator)),
    -- Resume restores an epub-cfi position only if the text there still starts with quote (ADR-029).
    CONSTRAINT ck_reading_state_current_locator_quote
        CHECK (current_locator ->> 'scheme' <> 'epub-cfi' OR current_locator ? 'quote'),
    CONSTRAINT ck_reading_state_frontier_locator CHECK (public.is_locator(frontier_locator)),
    CONSTRAINT ck_reading_state_book_fraction CHECK (book_fraction BETWEEN 0 AND 1),
    CONSTRAINT ck_reading_state_frontier_fraction CHECK (frontier_fraction BETWEEN 0 AND 1),
    CONSTRAINT ck_reading_state_frontier CHECK ((frontier_locator IS NULL) = (frontier_fraction IS NULL)),
    CONSTRAINT ck_reading_state_revision CHECK (revision > 0),
    CONSTRAINT fk_reading_state_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE public.reading_state IS
    'Reading. The accepted position and frontier of one user in one book (one file version); last writer wins by revision.';

-- client_session_id makes a replayed upload of the same session a no-op. book_id is NULL for a
-- session of a deleted book: it still counts in totals and streaks, and deleted_book_sha256
-- re-attaches it if the same file is uploaded again.
CREATE TABLE public.reading_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid,
    client_session_id uuid NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz NOT NULL,
    duration_seconds integer NOT NULL,
    words_read integer NOT NULL,
    start_percent numeric NOT NULL,
    end_percent numeric NOT NULL,
    deleted_book_sha256 varchar(64),
    created_at timestamptz NOT NULL,
    CONSTRAINT pk_reading_sessions PRIMARY KEY (id),
    CONSTRAINT ak_reading_sessions_user_id_client_session_id UNIQUE (user_id, client_session_id),
    CONSTRAINT fk_reading_sessions_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE,
    CONSTRAINT fk_reading_sessions_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE SET NULL (book_id)
);
CREATE INDEX ix_reading_sessions_user_id_started_at ON public.reading_sessions (user_id, started_at);
CREATE INDEX ix_reading_sessions_user_id_book_id ON public.reading_sessions (user_id, book_id) WHERE book_id IS NOT NULL;
COMMENT ON TABLE public.reading_sessions IS
    'Reading. One reading interval of one user, for stats and streaks; outlives a deleted book (book_id NULL).';

-- ===== Annotations =====

-- A highlight with an optional note. A migrated catalog quotation is unanchored: no locator, no
-- file, but selected_text is always there. A locator needs the file version it points into.
CREATE TABLE public.annotations (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid,
    selected_text text NOT NULL,
    note_text text,
    locator jsonb,
    color text NOT NULL DEFAULT 'yellow',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- A sync tombstone; how long it is kept is not decided.
    deleted_at timestamptz,
    revision bigint NOT NULL DEFAULT 1,
    CONSTRAINT pk_annotations PRIMARY KEY (id),
    CONSTRAINT ck_annotations_selected_text CHECK (btrim(selected_text) <> ''),
    CONSTRAINT ck_annotations_locator CHECK (public.is_locator(locator)),
    CONSTRAINT ck_annotations_locator_file CHECK (locator IS NULL OR file_id IS NOT NULL),
    CONSTRAINT ck_annotations_revision CHECK (revision > 0),
    CONSTRAINT fk_annotations_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE,
    -- Provenance: deferred, so an account delete can cascade through books first (rule 9).
    CONSTRAINT fk_annotations_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_annotations_user_id_book_id ON public.annotations (user_id, book_id);
CREATE INDEX ix_annotations_user_id_book_id_file_id ON public.annotations (user_id, book_id, file_id) WHERE file_id IS NOT NULL;
COMMENT ON TABLE public.annotations IS
    'Annotations. A highlight with an optional note, or an unanchored quotation; soft-deleted (deleted_at).';

-- ===== Vocabulary =====

-- One card per word across books, not one per example. The unique key includes tombstones, so an
-- offline retry cannot create a second card; re-saving a deleted word needs an explicit restore.
CREATE TABLE public.vocabulary_words (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    language text NOT NULL,
    word text NOT NULL,
    -- The application's language-aware lowercasing of word; database lower() is not assumed to match it.
    word_key text NOT NULL,
    translation text,
    definition text,
    stage integer NOT NULL DEFAULT 0,
    interval_days numeric NOT NULL DEFAULT 0,
    consecutive_correct integer NOT NULL DEFAULT 0,
    next_review_at timestamptz NOT NULL DEFAULT now(),
    last_reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    revision bigint NOT NULL DEFAULT 1,
    CONSTRAINT pk_vocabulary_words PRIMARY KEY (id),
    CONSTRAINT ak_vocabulary_words_user_id_id UNIQUE (user_id, id),
    CONSTRAINT ak_vocabulary_words_user_id_language_word_key UNIQUE (user_id, language, word_key),
    CONSTRAINT ck_vocabulary_words_language CHECK (btrim(language) <> ''),
    CONSTRAINT ck_vocabulary_words_word CHECK (btrim(word) <> ''),
    CONSTRAINT ck_vocabulary_words_word_key CHECK (btrim(word_key) <> ''),
    CONSTRAINT ck_vocabulary_words_stage CHECK (stage >= 0),
    CONSTRAINT ck_vocabulary_words_interval_days CHECK (interval_days >= 0),
    CONSTRAINT ck_vocabulary_words_consecutive_correct CHECK (consecutive_correct >= 0),
    CONSTRAINT ck_vocabulary_words_revision CHECK (revision > 0),
    CONSTRAINT fk_vocabulary_words_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
-- The review queue: live cards by due time.
CREATE INDEX ix_vocabulary_words_user_id_next_review_at ON public.vocabulary_words (user_id, next_review_at) WHERE deleted_at IS NULL;
COMMENT ON TABLE public.vocabulary_words IS
    'Vocabulary. One learning card per user, language and word_key, with its review schedule; soft-deleted (deleted_at).';

-- A source sentence and its contextual translation; saving one never changes the card's own
-- translation or schedule. operation_id identifies a retry, not duplicate content: a new
-- operation with the same sentence is a second example.
CREATE TABLE public.vocabulary_examples (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    word_id uuid NOT NULL,
    book_id uuid,
    file_id uuid,
    -- A resource key within the file, when known; not a database chapter id.
    chapter_key text,
    -- Snapshot, so the example keeps its source even when it never was a library book.
    book_title text,
    sentence text NOT NULL,
    contextual_translation text,
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT pk_vocabulary_examples PRIMARY KEY (id),
    CONSTRAINT ak_vocabulary_examples_user_id_operation_id UNIQUE (user_id, operation_id),
    CONSTRAINT ck_vocabulary_examples_sentence CHECK (btrim(sentence) <> ''),
    CONSTRAINT ck_vocabulary_examples_payload_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_vocabulary_examples_file_book CHECK (file_id IS NULL OR book_id IS NOT NULL),
    CONSTRAINT ck_vocabulary_examples_chapter_key CHECK (chapter_key IS NULL OR (book_id IS NOT NULL AND btrim(chapter_key) <> '')),
    CONSTRAINT fk_vocabulary_examples_vocabulary_words_user_id_word_id FOREIGN KEY (user_id, word_id)
        REFERENCES public.vocabulary_words (user_id, id) ON DELETE CASCADE,
    -- Provenance: deferred (rule 9).
    CONSTRAINT fk_vocabulary_examples_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_vocabulary_examples_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_vocabulary_examples_user_id_word_id_created_at_id ON public.vocabulary_examples (user_id, word_id, created_at, id);
CREATE INDEX ix_vocabulary_examples_user_id_book_id ON public.vocabulary_examples (user_id, book_id) WHERE book_id IS NOT NULL;
CREATE INDEX ix_vocabulary_examples_user_id_book_id_file_id ON public.vocabulary_examples (user_id, book_id, file_id) WHERE file_id IS NOT NULL;
COMMENT ON TABLE public.vocabulary_examples IS
    'Vocabulary. A source sentence (and contextual translation) for one card.';

-- One answer. Its card's schedule is updated in the same transaction. A deleted card is a
-- tombstone, so its history is not erased with it.
CREATE TABLE public.vocabulary_reviews (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    word_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL,
    -- No CHECK: the clients own the review styles, so pinning them here makes a UI change a migration.
    review_mode text NOT NULL,
    is_correct boolean NOT NULL,
    response_time_ms integer,
    stage_before integer NOT NULL,
    stage_after integer NOT NULL,
    client_recorded_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_vocabulary_reviews PRIMARY KEY (id),
    CONSTRAINT ak_vocabulary_reviews_user_id_operation_id UNIQUE (user_id, operation_id),
    CONSTRAINT ck_vocabulary_reviews_payload_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_vocabulary_reviews_review_mode CHECK (btrim(review_mode) <> ''),
    CONSTRAINT ck_vocabulary_reviews_response_time_ms CHECK (response_time_ms >= 0),
    CONSTRAINT ck_vocabulary_reviews_stage_before CHECK (stage_before >= 0),
    CONSTRAINT ck_vocabulary_reviews_stage_after CHECK (stage_after >= 0),
    CONSTRAINT fk_vocabulary_reviews_vocabulary_words_user_id_word_id FOREIGN KEY (user_id, word_id)
        REFERENCES public.vocabulary_words (user_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_vocabulary_reviews_user_id_word_id_created_at_id ON public.vocabulary_reviews (user_id, word_id, created_at, id);
COMMENT ON TABLE public.vocabulary_reviews IS
    'Vocabulary. One review answer for one card; append-only.';

-- ===== Discussion =====

-- Immutable: sharing again makes a new snapshot, so there is no UNIQUE on chapter_key. Removing the
-- book keeps it; deleting it needs its checkpoints unlinked first (their FK refuses otherwise).
CREATE TABLE public.shared_chapters (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid,
    chapter_key text NOT NULL,
    chapter_title text,
    chapter_text text NOT NULL,
    notes_snapshot jsonb NOT NULL DEFAULT '[]',
    language text,
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_shared_chapters PRIMARY KEY (id),
    CONSTRAINT ak_shared_chapters_user_id_book_id_id UNIQUE (user_id, book_id, id),
    CONSTRAINT ak_shared_chapters_user_id_operation_id UNIQUE (user_id, operation_id),
    CONSTRAINT ck_shared_chapters_chapter_key CHECK (btrim(chapter_key) <> ''),
    CONSTRAINT ck_shared_chapters_chapter_text CHECK (btrim(chapter_text) <> ''),
    CONSTRAINT ck_shared_chapters_notes_snapshot CHECK (jsonb_typeof(notes_snapshot) = 'array'),
    CONSTRAINT ck_shared_chapters_payload_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT fk_shared_chapters_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE,
    -- Provenance: deferred (rule 9).
    CONSTRAINT fk_shared_chapters_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_shared_chapters_user_id_book_id_created_at_id ON public.shared_chapters (user_id, book_id, created_at, id);
CREATE INDEX ix_shared_chapters_user_id_book_id_file_id ON public.shared_chapters (user_id, book_id, file_id) WHERE file_id IS NOT NULL;
COMMENT ON TABLE public.shared_chapters IS
    'Discussion. An immutable chapter snapshot the user shared with an assistant (MCP).';

-- One saved stage of a discussion; a new stage appends a row. Its optional share must be the same
-- chapter and file version: the write checks that, the FK only checks owner and book. Enabling
-- books.checkpoint_saving_enabled does not authorize capturing a transcript.
CREATE TABLE public.discussion_checkpoints (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid,
    chapter_key text,
    shared_chapter_id uuid,
    topic text NOT NULL,
    reader_thoughts jsonb NOT NULL DEFAULT '[]',
    assistant_suggestions jsonb NOT NULL DEFAULT '[]',
    conclusions jsonb NOT NULL DEFAULT '[]',
    open_questions jsonb NOT NULL DEFAULT '[]',
    language text NOT NULL,
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_discussion_checkpoints PRIMARY KEY (id),
    CONSTRAINT ak_discussion_checkpoints_user_id_operation_id UNIQUE (user_id, operation_id),
    CONSTRAINT ck_discussion_checkpoints_topic CHECK (btrim(topic) <> ''),
    CONSTRAINT ck_discussion_checkpoints_chapter_key CHECK (chapter_key IS NULL OR btrim(chapter_key) <> ''),
    CONSTRAINT ck_discussion_checkpoints_reader_thoughts CHECK (jsonb_typeof(reader_thoughts) = 'array'),
    CONSTRAINT ck_discussion_checkpoints_assistant_suggestions CHECK (jsonb_typeof(assistant_suggestions) = 'array'),
    CONSTRAINT ck_discussion_checkpoints_conclusions CHECK (jsonb_typeof(conclusions) = 'array'),
    CONSTRAINT ck_discussion_checkpoints_open_questions CHECK (jsonb_typeof(open_questions) = 'array'),
    CONSTRAINT ck_discussion_checkpoints_not_empty CHECK (jsonb_array_length(reader_thoughts)
        + jsonb_array_length(assistant_suggestions) + jsonb_array_length(conclusions)
        + jsonb_array_length(open_questions) > 0),
    CONSTRAINT ck_discussion_checkpoints_language CHECK (btrim(language) <> ''),
    CONSTRAINT ck_discussion_checkpoints_payload_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT fk_discussion_checkpoints_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE,
    -- Provenance: deferred (rule 9).
    CONSTRAINT fk_discussion_checkpoints_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED,
    -- Deleting a share first clears shared_chapter_id here, in the same transaction; the
    -- checkpoint's own text survives. The name drops user_id_book_id: 63 characters is the limit.
    CONSTRAINT fk_discussion_checkpoints_shared_chapters_shared_chapter_id
        FOREIGN KEY (user_id, book_id, shared_chapter_id)
        REFERENCES public.shared_chapters (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_discussion_checkpoints_user_id_book_id_created_at_id ON public.discussion_checkpoints (user_id, book_id, created_at, id);
CREATE INDEX ix_discussion_checkpoints_user_id_book_id_shared_chapter_id ON public.discussion_checkpoints (user_id, book_id, shared_chapter_id) WHERE shared_chapter_id IS NOT NULL;
CREATE INDEX ix_discussion_checkpoints_user_id_book_id_file_id ON public.discussion_checkpoints (user_id, book_id, file_id) WHERE file_id IS NOT NULL;
COMMENT ON TABLE public.discussion_checkpoints IS
    'Discussion. One saved stage of a discussion about a book; append-only.';

-- An assistant's conclusion about a book (chapter_slug NULL) or one chapter, or a chapter review
-- (review_json, ADR-016). Saving again for the same book and chapter replaces the row.
CREATE TABLE public.book_insight (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    chapter_slug varchar(300),
    text text NOT NULL,
    question varchar(1000),
    source varchar(32) NOT NULL DEFAULT 'mcp',
    review_json jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT pk_book_insight PRIMARY KEY (id),
    -- A second source (the app itself) adds its value here, in a migration.
    CONSTRAINT ck_book_insight_source CHECK (source IN ('mcp')),
    -- The target of review_question's ownership FK.
    CONSTRAINT ak_book_insight_user_id_id UNIQUE (user_id, id),
    CONSTRAINT fk_book_insight_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_book_insight_user_id_book_id_chapter_slug ON public.book_insight (user_id, book_id, chapter_slug) NULLS NOT DISTINCT;
COMMENT ON TABLE public.book_insight IS
    'Discussion. An assistant conclusion about a book or chapter, or a chapter review (ADR-016); one per book and chapter.';

-- A self-check question from a chapter review, with its own review schedule.
CREATE TABLE public.review_question (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_insight_id uuid NOT NULL,
    block_index integer NOT NULL,
    prompt varchar(500) NOT NULL,
    answer varchar(1500) NOT NULL,
    prompt_hash varchar(16) NOT NULL,
    stage integer NOT NULL,
    interval_days double precision NOT NULL,
    consecutive_correct integer NOT NULL,
    next_review_at timestamptz NOT NULL,
    last_reviewed_at timestamptz,
    total_reviews integer NOT NULL,
    correct_reviews integer NOT NULL,
    is_retired boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT pk_review_question PRIMARY KEY (id),
    CONSTRAINT fk_review_question_book_insight_user_id_book_insight_id FOREIGN KEY (user_id, book_insight_id)
        REFERENCES public.book_insight (user_id, id) ON DELETE CASCADE
);
-- Re-saving a review keeps a question's schedule when its prompt is unchanged.
CREATE UNIQUE INDEX ix_review_question_book_insight_id_prompt_hash ON public.review_question (book_insight_id, prompt_hash);
-- The review queue.
CREATE INDEX ix_review_question_user_id_is_retired_next_review_at ON public.review_question (user_id, is_retired, next_review_at);
COMMENT ON TABLE public.review_question IS
    'Discussion. A self-check question of a chapter review (book_insight), with its review schedule.';

-- ===== Ops =====

-- user_id has no FK: a trace outlives its user (cost history), and holds only scrubbed text.
CREATE TABLE public.llm_traces (
    id uuid NOT NULL,
    feature_tag varchar(64) NOT NULL,
    model_id varchar(128) NOT NULL,
    prompt_hash varchar(64) NOT NULL,
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
    created_at timestamptz NOT NULL,
    CONSTRAINT pk_llm_traces PRIMARY KEY (id)
);
CREATE INDEX ix_llm_traces_feature_tag_created_at ON public.llm_traces (feature_tag, created_at);
CREATE INDEX ix_llm_traces_user_id ON public.llm_traces (user_id) WHERE user_id IS NOT NULL;
COMMENT ON TABLE public.llm_traces IS
    'Ops. One LLM call through the gateway: model, tokens, cost, latency, scrubbed text.';

-- steps_json is the run's trace, step by step.
CREATE TABLE public.agent_run (
    id uuid NOT NULL,
    agent varchar(64) NOT NULL,
    user_id uuid,
    goal text NOT NULL,
    status varchar(32) NOT NULL,
    output text,
    steps_json jsonb NOT NULL,
    iterations integer NOT NULL,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_usd numeric(10,6) NOT NULL,
    latency_ms integer NOT NULL,
    error text,
    created_at timestamptz NOT NULL,
    confidence double precision,
    tool_calls_count integer NOT NULL DEFAULT 0,
    CONSTRAINT pk_agent_run PRIMARY KEY (id),
    CONSTRAINT ck_agent_run_status CHECK (status IN ('completed', 'budget_exhausted', 'error')),
    CONSTRAINT fk_agent_run_users_user_id FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE INDEX ix_agent_run_user_id_created_at ON public.agent_run (user_id, created_at) WHERE user_id IS NOT NULL;
COMMENT ON TABLE public.agent_run IS
    'Ops. One agent run with its steps; a user''s runs go with the account.';

-- Written by the eval suite; read by the admin AI Quality page.
CREATE TABLE public.eval_runs (
    id uuid NOT NULL,
    feature varchar(64) NOT NULL,
    model_id varchar(128) NOT NULL,
    judge_model_id varchar(128) NOT NULL,
    score numeric(6,3) NOT NULL,
    n integer NOT NULL,
    breakdown_json jsonb,
    git_sha varchar(64),
    created_at timestamptz NOT NULL,
    run_type varchar(20) NOT NULL DEFAULT 'manual',
    CONSTRAINT pk_eval_runs PRIMARY KEY (id),
    CONSTRAINT ck_eval_runs_run_type CHECK (run_type IN ('manual', 'scheduled'))
);
CREATE INDEX ix_eval_runs_feature_created_at ON public.eval_runs (feature, created_at);
COMMENT ON TABLE public.eval_runs IS
    'Ops. One eval score of one feature and model, manual or scheduled.';

-- Kept as a table (Q6): moving these to configuration would make every tweak a deploy.
CREATE TABLE public.admin_settings (
    key varchar(100) NOT NULL,
    value varchar(500) NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT pk_admin_settings PRIMARY KEY (key)
);
COMMENT ON TABLE public.admin_settings IS
    'Ops. One runtime setting edited from the admin panel.';

-- ===== Transitional: dropped at M6.4 =====
-- They feed the legacy reader, get_my_chapter and shared_chapters snapshots; nothing new may
-- depend on them.

-- Keyed by file version, not book: re-extracting another version cannot mix chapters.
-- chapter_key is the chapter's slug ('ch-' || chapter_number when it had none); chapter_number
-- only orders, it is never shown.
CREATE TABLE public.book_chapters (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid NOT NULL,
    chapter_key text NOT NULL,
    chapter_number integer NOT NULL,
    title varchar(500) NOT NULL,
    html text NOT NULL,
    plain_text text NOT NULL,
    word_count integer,
    source_start_page integer,
    source_end_page integer,
    created_at timestamptz NOT NULL,
    CONSTRAINT pk_book_chapters PRIMARY KEY (id),
    CONSTRAINT ak_book_chapters_user_id_file_id_chapter_key UNIQUE (user_id, file_id, chapter_key),
    CONSTRAINT ck_book_chapters_chapter_key CHECK (btrim(chapter_key) <> ''),
    CONSTRAINT fk_book_chapters_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE
);
-- The table of contents, in order.
CREATE UNIQUE INDEX ix_book_chapters_user_id_book_id_file_id_chapter_number ON public.book_chapters (user_id, book_id, file_id, chapter_number);
COMMENT ON TABLE public.book_chapters IS
    'Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031. Reading module: a server-extracted chapter of one file version.';

CREATE TABLE public.ingestion_jobs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL,
    error text,
    -- What the extractor detected, as book_files.format plus the outcomes that are not a V2 format.
    source_format text,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT pk_ingestion_jobs PRIMARY KEY (id),
    CONSTRAINT ck_ingestion_jobs_status CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
    CONSTRAINT ck_ingestion_jobs_source_format
        CHECK (source_format IN ('epub', 'pdf', 'html', 'fb2', 'unknown')),
    CONSTRAINT fk_ingestion_jobs_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_ingestion_jobs_status ON public.ingestion_jobs (status);
CREATE INDEX ix_ingestion_jobs_created_at ON public.ingestion_jobs (created_at);
CREATE INDEX ix_ingestion_jobs_user_id_book_id_file_id ON public.ingestion_jobs (user_id, book_id, file_id);
COMMENT ON TABLE public.ingestion_jobs IS
    'Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031. Library module: a server extraction job for one uploaded file.';
