-- 0002_identity_and_indexes — M2.5's identity bundle (#1092) and the indexes M1.5–M2.4 asked for (#1047)
--
-- What:  seven changes, one per section below: users.credentials_reset_at; user_refresh_tokens.kind
--          (replaces the 'adm.' hash prefix) and family_id with its index, every existing session
--          signed out; four change-feed indexes (books, reading_state, annotations,
--          vocabulary_words); the vocabulary due index re-keyed with id; three sweep indexes
--          (password_reset_tokens.expires_at, and oauth_grants' refresh_token_expires_at and
--          revoked_at); device user codes unique among pending logins, every pending login
--          expired; a chapter-filtered checkpoint index.
-- Why:   #1092 (owner decision 2026-11-02): a password reset must kill every credential issued
--          before it, access tokens included; the session family and kind become columns instead of
--          recursive chain walks and a hash prefix. #1047: every keyset page and sweep walks an index.
-- Issue: https://github.com/mrviduus/textstack/issues/1092
--        https://github.com/mrviduus/textstack/issues/1047
-- Compatibility: textstack_v2 holds no real data and nothing deployed resolves a V2 repository
--                (M5.1 does). Every V2 session is deleted (signed out) rather than backfilled: the
--                code before 0002 kept no family, and M5's session port starts families fresh.
--                Every pending device login is expired: 0001's code refused a code shown by a live
--                pending login only, so pending logins past their deadline may share a code, which
--                the unique index refuses; a device mid-flow asks for a new code. Every other change
--                is a nullable column or an index.
-- Down:  0002_identity_and_indexes.down.sql puts every index back as 0001 left it, signs every
--        session out again (the code before 0002 would read an admin session as a reader's) and
--        drops the three columns — with whatever they hold. Expired device logins stay expired.

-- ===== Identity: a password reset stamps the account =====

-- Set by the reset in the statement that spends its code. A credential minted from an access token
-- issued before it (iat < credentials_reset_at) is refused: the reset cannot reach a JWT, only the
-- writes that would turn one into a new session, device approval or MCP key.
ALTER TABLE public.users ADD COLUMN credentials_reset_at timestamptz;

-- ===== Identity: a session says whose it is and which sign-in it belongs to =====

-- Admin and reader sessions are not interchangeable (until now an admin's hash was stored as
-- 'adm.' || hash); token_hash stays unique across kinds, hashes never collide. A sign-in's first
-- session starts a family (family_id = its id) and a rotation copies it, so a replayed token revokes
-- its family in one DELETE and the absolute lifetime reads the family's first row: nothing walks
-- previous_token_hash back. The sweep deletes a family whole once none of it lives, so that first row
-- is there while any member is. No DEFAULT: every insert names both.
DELETE FROM public.user_refresh_tokens;
ALTER TABLE public.user_refresh_tokens
    ADD COLUMN kind text NOT NULL,
    ADD CONSTRAINT ck_user_refresh_tokens_kind CHECK (kind IN ('reader', 'admin')),
    ADD COLUMN family_id uuid NOT NULL;
-- RevokeFamily by the leading column; the sweep's "does any of this family still live" probe by both.
CREATE INDEX ix_user_refresh_tokens_family_id_expires_at ON public.user_refresh_tokens (family_id, expires_at);

-- ===== Sync: the change feeds =====

-- Each feed pages by WHERE user_id = @userId AND (updated_at, key) > (@since, @after) ORDER BY
-- updated_at, key. Tombstones are part of a feed, so no index is partial. reading_state's key is
-- book_id (its primary key is (user_id, book_id)).
CREATE INDEX ix_books_user_id_updated_at_id ON public.books (user_id, updated_at, id);
CREATE INDEX ix_reading_state_user_id_updated_at_book_id ON public.reading_state (user_id, updated_at, book_id);
CREATE INDEX ix_annotations_user_id_updated_at_id ON public.annotations (user_id, updated_at, id);
CREATE INDEX ix_vocabulary_words_user_id_updated_at_id ON public.vocabulary_words (user_id, updated_at, id);

-- ===== Vocabulary: the due queue in its page order =====

-- ListDueAsync orders by next_review_at, id; without id, cards due at one instant are sorted again
-- before the LIMIT. 0001's predicate kept.
DROP INDEX public.ix_vocabulary_words_user_id_next_review_at;
CREATE INDEX ix_vocabulary_words_user_id_next_review_at
    ON public.vocabulary_words (user_id, next_review_at, id) WHERE deleted_at IS NULL AND retired_at IS NULL;

-- ===== Identity: what the sweeps walk =====

-- DeleteExpiredPasswordResetsAsync: expires_at < @expiredBefore.
CREATE INDEX ix_password_reset_tokens_expires_at ON public.password_reset_tokens (expires_at);
-- DeleteDeadGrantsAsync: revoked_at < @before OR refresh_token_expires_at < @before. An OR uses
-- indexes only when each arm has one (a bitmap OR); with one of the two it is a sequential scan.
CREATE INDEX ix_oauth_grants_refresh_token_expires_at ON public.oauth_grants (refresh_token_expires_at);
CREATE INDEX ix_oauth_grants_revoked_at ON public.oauth_grants (revoked_at) WHERE revoked_at IS NOT NULL;

-- ===== Identity: a user code shows one pending login =====

-- A pending login past its deadline may share its code with a newer one (0001 refused only a live
-- code); the unique index would refuse them. Expiring every pending login is simplest: a device
-- mid-flow asks for a new code.
UPDATE public.device_authorizations SET status = 'expired' WHERE status = 'pending';

-- Two device logins created at once with one random code both landed under the insert's NOT
-- EXISTS; unique, the second insert fails (23505) and the caller mints another code. A pending
-- login past its deadline holds its code until it is decided or swept.
DROP INDEX public.ix_device_authorizations_user_code;
CREATE UNIQUE INDEX ix_device_authorizations_user_code ON public.device_authorizations (user_code) WHERE status = 'pending';

-- ===== Discussion: one chapter's checkpoints =====

-- The ?chapterKey= page walks one chapter's checkpoints in (created_at, id) order; the book-wide
-- index would filter chapter_key row by row. The name stops at chapter_key: the full column list
-- passes Postgres's 63-character limit.
CREATE INDEX ix_discussion_checkpoints_user_id_book_id_chapter_key
    ON public.discussion_checkpoints (user_id, book_id, chapter_key, created_at, id);
