-- Undoes 0002_identity_and_indexes: every index back as 0001 left it, admin sessions re-prefixed,
-- then the four columns dropped — with whatever they hold.

DROP INDEX public.ix_discussion_checkpoints_user_id_book_id_chapter_key;

DROP INDEX public.ix_device_authorizations_user_code;
CREATE INDEX ix_device_authorizations_user_code ON public.device_authorizations (user_code) WHERE status = 'pending';

DROP INDEX public.ix_oauth_grants_revoked_at;
DROP INDEX public.ix_oauth_grants_refresh_token_expires_at;
DROP INDEX public.ix_password_reset_tokens_expires_at;

DROP INDEX public.ix_vocabulary_words_user_id_next_review_at;
CREATE INDEX ix_vocabulary_words_user_id_next_review_at
    ON public.vocabulary_words (user_id, next_review_at) WHERE deleted_at IS NULL AND retired_at IS NULL;

DROP INDEX public.ix_vocabulary_words_user_id_updated_at_id;
DROP INDEX public.ix_annotations_user_id_updated_at_id;
DROP INDEX public.ix_reading_state_user_id_updated_at_book_id;
DROP INDEX public.ix_books_user_id_updated_at_id;

DROP INDEX public.ix_user_refresh_tokens_family_id;
ALTER TABLE public.user_refresh_tokens
    DROP COLUMN family_started_at,
    DROP COLUMN family_id;

-- The code before 0002 finds an admin session only by its prefixed hash.
UPDATE public.user_refresh_tokens SET
    token_hash = 'adm.' || token_hash,
    previous_token_hash = 'adm.' || previous_token_hash
WHERE kind = 'admin';
ALTER TABLE public.user_refresh_tokens
    DROP CONSTRAINT ck_user_refresh_tokens_kind,
    DROP COLUMN kind;

ALTER TABLE public.users DROP COLUMN credentials_reset_at;
