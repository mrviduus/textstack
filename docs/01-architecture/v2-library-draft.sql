-- DISCUSSION ONLY, 2026-10-29. Not a migration; do not run against an application database.
-- Nine candidate SERVER tables. Accountless local storage is a separate client contract.
-- public.users is an existing dependency, not defined or redesigned here.
-- v2_draft is a review namespace; final names and migration strategy are not accepted.

CREATE SCHEMA v2_draft;

-- 1. A reader's library entry. Its id survives renames and explicit file replacement.
-- Owner decision: remove from the active library, retain hidden provenance and saved quotations.
-- removed_at is the candidate mechanism; file-byte retention is a separate decision.
CREATE TABLE v2_draft.books (
    id uuid PRIMARY KEY, -- client-generated for offline creation
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (btrim(title) <> ''),
    author text,
    language text,
    checkpoint_saving_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    UNIQUE (user_id, id)
);

-- 2. File-version metadata. A row does NOT imply that cloud bytes exist.
-- A device path never belongs here. Local file availability is per device.
-- After successful replacement retain current bytes only; keep old rows/hashes for annotation
-- provenance. Clear old server storage keys only when file deletion succeeds; retry separately.
CREATE TABLE v2_draft.book_files (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    original_name text NOT NULL CHECK (btrim(original_name) <> ''),
    format text NOT NULL CHECK (format = 'epub'), -- first slice only; existing PDF remains untouched
    server_storage_key text CHECK (server_storage_key IS NULL OR btrim(server_storage_key) <> ''),
    is_current boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, book_id, id),
    UNIQUE (user_id, book_id, sha256),
    FOREIGN KEY (user_id, book_id) REFERENCES v2_draft.books(user_id, id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX book_files_one_current
    ON v2_draft.book_files(user_id, book_id) WHERE is_current;
CREATE INDEX book_files_owner_hash ON v2_draft.book_files(user_id, sha256);
-- No owner-wide hash UNIQUE: do not collapse distinct library entries or archived versions
-- without the user-facing import policy. Duplicate detection queries are always owner-scoped.

-- 3. One accepted reading state per book; current position and frontier are different concepts.
-- Owner approved the separate-table boundary; the column contract is still a proposal.
-- Proposed locator envelope: {"version":1,"scheme":"epub-cfi","value":"epubcfi(...)"}.
-- JSON shape checks below do not validate a CFI; the application must validate/resolve it.
CREATE TABLE v2_draft.reading_state (
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid NOT NULL,
    current_locator jsonb NOT NULL CHECK (jsonb_typeof(current_locator) = 'object'),
    current_quote text, -- verification/fallback context; exact capture contract still open
    book_fraction numeric NOT NULL CHECK (book_fraction BETWEEN 0 AND 1),
    frontier_locator jsonb CHECK (frontier_locator IS NULL OR jsonb_typeof(frontier_locator) = 'object'),
    frontier_fraction numeric CHECK (frontier_fraction BETWEEN 0 AND 1),
    completed_at timestamptz,
    client_recorded_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(), -- server acceptance time
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (user_id, book_id),
    CHECK ((frontier_locator IS NULL) = (frontier_fraction IS NULL)),
    FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES v2_draft.book_files(user_id, book_id, id) ON DELETE CASCADE
);
-- Candidate write rules: moving backward does not lower frontier; explicit reset may.
-- CFI strings are not sortable reading positions. Fractions are scoped to the same file/layout
-- contract and cannot establish semantic read coverage or a cross-version spoiler boundary.
-- Replacing bytes resets state unless compatibility was actually verified.
-- Clock conflict, stale revision and explicit reset protocols still require a sync PDD.

-- 4. Highlights with attached notes. Unanchored legacy quotations are first-class records.
CREATE TABLE v2_draft.annotations (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid,
    selected_text text NOT NULL CHECK (btrim(selected_text) <> ''),
    note_text text,
    locator jsonb CHECK (locator IS NULL OR jsonb_typeof(locator) = 'object'),
    color text NOT NULL DEFAULT 'yellow',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz, -- proposed sync tombstone, not a chosen retention duration
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK (locator IS NULL OR file_id IS NOT NULL),
    FOREIGN KEY (user_id, book_id) REFERENCES v2_draft.books(user_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES v2_draft.book_files(user_id, book_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX annotations_owner_book ON v2_draft.annotations(user_id, book_id);
CREATE INDEX annotations_source_file ON v2_draft.annotations(user_id, book_id, file_id)
    WHERE file_id IS NOT NULL;

-- 5. One learning card across books, with its current schedule, not one card per example.
-- word_key is produced by a documented language-aware lowercase contract in the application.
-- Do not assume database lower() and every client's Unicode rules are interchangeable.
CREATE TABLE v2_draft.vocabulary_words (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    language text NOT NULL CHECK (btrim(language) <> ''),
    word text NOT NULL CHECK (btrim(word) <> ''),
    word_key text NOT NULL CHECK (btrim(word_key) <> ''),
    translation text,
    definition text,
    stage integer NOT NULL DEFAULT 0 CHECK (stage >= 0),
    interval_days numeric NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
    consecutive_correct integer NOT NULL DEFAULT 0 CHECK (consecutive_correct >= 0),
    next_review_at timestamptz NOT NULL DEFAULT now(),
    last_reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (user_id, id),
    UNIQUE (user_id, language, word_key)
);
CREATE INDEX vocabulary_words_due ON v2_draft.vocabulary_words(user_id, next_review_at)
    WHERE deleted_at IS NULL;
-- Uniqueness includes tombstones: do not create a second card on an offline retry.
-- Restore/re-save after intentional deletion needs an explicit contract, not automatic resurrection.
-- Existing tutor/clustering/retirement fields need a disposition before migrating current words.

-- 6. The source sentence and its contextual translation; primary card translation stays unchanged.
CREATE TABLE v2_draft.vocabulary_examples (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    word_id uuid NOT NULL,
    book_id uuid,
    file_id uuid,
    chapter_key text, -- resource href/key within a specific file when known, not a DB chapter id
    book_title text, -- source snapshot, also usable when the source was never a personal book
    sentence text NOT NULL CHECK (btrim(sentence) <> ''),
    contextual_translation text,
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (user_id, operation_id),
    CHECK (file_id IS NULL OR book_id IS NOT NULL),
    CHECK (chapter_key IS NULL OR (book_id IS NOT NULL AND btrim(chapter_key) <> '')),
    FOREIGN KEY (user_id, word_id) REFERENCES v2_draft.vocabulary_words(user_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (user_id, book_id) REFERENCES v2_draft.books(user_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES v2_draft.book_files(user_id, book_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX vocabulary_examples_word ON v2_draft.vocabulary_examples(user_id, word_id, created_at, id);
CREATE INDEX vocabulary_examples_book ON v2_draft.vocabulary_examples(user_id, book_id)
    WHERE book_id IS NOT NULL;
CREATE INDEX vocabulary_examples_file ON v2_draft.vocabulary_examples(user_id, book_id, file_id)
    WHERE file_id IS NOT NULL;
-- Retry identity is not a content-deduplication rule. A new operation with the same example may
-- still be duplicate content; exact-context deduplication is a remaining application decision.

-- 7. Review history. Update the word's schedule and append the review in one transaction.
CREATE TABLE v2_draft.vocabulary_reviews (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    word_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    review_mode text NOT NULL CHECK (btrim(review_mode) <> ''),
    is_correct boolean NOT NULL,
    response_time_ms integer CHECK (response_time_ms >= 0),
    stage_before integer NOT NULL CHECK (stage_before >= 0),
    stage_after integer NOT NULL CHECK (stage_after >= 0),
    client_recorded_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, operation_id),
    FOREIGN KEY (user_id, word_id) REFERENCES v2_draft.vocabulary_words(user_id, id)
        ON DELETE CASCADE
);
CREATE INDEX vocabulary_reviews_word ON v2_draft.vocabulary_reviews(user_id, word_id, created_at, id);
-- Deleting a card is initially a tombstone, so its review history is not silently erased.
-- Hard purge, retention and stale review handling still need an explicit sync/learning contract.

-- 8. Explicit chapter snapshot. Not an automatically extracted server catalog chapter.
CREATE TABLE v2_draft.shared_chapters (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid,
    chapter_key text NOT NULL CHECK (btrim(chapter_key) <> ''),
    chapter_title text,
    chapter_text text NOT NULL CHECK (btrim(chapter_text) <> ''),
    notes_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(notes_snapshot) = 'array'),
    language text,
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, book_id, id),
    UNIQUE (user_id, operation_id),
    FOREIGN KEY (user_id, book_id) REFERENCES v2_draft.books(user_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES v2_draft.book_files(user_id, book_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX shared_chapters_book ON v2_draft.shared_chapters(user_id, book_id, created_at, id);
CREATE INDEX shared_chapters_file ON v2_draft.shared_chapters(user_id, book_id, file_id)
    WHERE file_id IS NOT NULL;
-- Proposed initial lifecycle: immutable snapshots; an explicit re-share creates a new snapshot.
-- No UNIQUE on chapter_key: chapter identity alone must not overwrite a prior snapshot.
-- User-visible book removal only sets books.removed_at, preserving shares.
-- A requested share deletion removes its row/content. Checkpoints retain text but lose that link.
-- Reject oversized requests and unexpected note payloads in the API; these JSON checks are shallow.

-- 9. Separate saved thoughts. This does not replace legacy save_insight/review semantics.
CREATE TABLE v2_draft.discussion_checkpoints (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid,
    chapter_key text,
    shared_chapter_id uuid,
    topic text NOT NULL CHECK (btrim(topic) <> ''),
    reader_thoughts jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(reader_thoughts) = 'array'),
    assistant_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(assistant_suggestions) = 'array'),
    conclusions jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(conclusions) = 'array'),
    open_questions jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(open_questions) = 'array'),
    language text NOT NULL CHECK (btrim(language) <> ''),
    operation_id uuid NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, operation_id),
    CHECK (file_id IS NULL OR book_id IS NOT NULL),
    CHECK (chapter_key IS NULL OR btrim(chapter_key) <> ''),
    CHECK (jsonb_array_length(reader_thoughts) + jsonb_array_length(assistant_suggestions)
        + jsonb_array_length(conclusions) + jsonb_array_length(open_questions) > 0),
    FOREIGN KEY (user_id, book_id) REFERENCES v2_draft.books(user_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES v2_draft.book_files(user_id, book_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (user_id, book_id, shared_chapter_id)
        REFERENCES v2_draft.shared_chapters(user_id, book_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX discussion_checkpoints_book
    ON v2_draft.discussion_checkpoints(user_id, book_id, created_at, id);
CREATE INDEX discussion_checkpoints_share
    ON v2_draft.discussion_checkpoints(user_id, book_id, shared_chapter_id)
    WHERE shared_chapter_id IS NOT NULL;
CREATE INDEX discussion_checkpoints_file
    ON v2_draft.discussion_checkpoints(user_id, book_id, file_id) WHERE file_id IS NOT NULL;
-- Share deletion: in one transaction clear matching checkpoints.shared_chapter_id, then delete
-- the share. NO ACTION prevents accidental deletion without unlinking; checkpoint content survives.
-- Validate optional checkpoint file/chapter against a linked share in the write transaction;
-- the owner/book FK alone cannot establish that they describe the same chapter/version.
-- Save APIs compare canonical payload digests: retry returns original; changed payload conflicts.
-- New thoughts append. Retries after intentional deletion must not recreate deleted records;
-- deletion receipts/tombstones and expiry are unresolved before a production implementation.
-- Enabling books.checkpoint_saving_enabled does not authorize full transcript capture or vocabulary writes.

-- No server chapter extraction or ingestion queue in this slice. Nine tables do not cover all V2.
-- Legacy book_insight, review_question, bookmarks, collections, auth and operations stay outside this DDL.
-- All reads/writes must also scope by authenticated user_id; FKs alone are not authorization.
-- updated_at/revision require explicit write logic; no implicit trigger behavior is assumed.
-- NO ACTION provenance FKs are deferred to transaction end: account cascades must remove books,
-- word cards and their dependent records before references are checked. Force SET CONSTRAINTS
-- ALL IMMEDIATE at validation boundaries to detect any remaining dangling references early.
