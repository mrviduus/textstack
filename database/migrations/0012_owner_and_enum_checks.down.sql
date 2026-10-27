-- Undoes 0012_owner_and_enum_checks: drops the CHECKs and the unique index, restores the plain
-- index and the SET NULL FKs exactly as 0000_baseline has them. Deleted ownerless rows are not
-- restored (see the up file).

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.highlights, public.reading_sessions, public.book_quality_jobs,
    public.book_collections, public.seo_templates, public.editions, public.user_books
    IN ACCESS EXCLUSIVE MODE;

DROP INDEX public.ix_seo_templates_entity_type_field_type_language_code;
CREATE INDEX ix_seo_templates_entity_type_field_type_language_code_is_active ON public.seo_templates USING btree (entity_type, field_type, language_code, is_active);

ALTER TABLE public.book_collections DROP CONSTRAINT ck_book_collections_book_type;
ALTER TABLE public.book_quality_jobs DROP CONSTRAINT ck_book_quality_jobs_owner;

ALTER TABLE public.reading_sessions
    DROP CONSTRAINT ck_reading_sessions_owner,
    DROP CONSTRAINT fk_reading_sessions_editions_edition_id,
    DROP CONSTRAINT fk_reading_sessions_user_books_user_book_id,
    ADD CONSTRAINT fk_reading_sessions_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_reading_sessions_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;

ALTER TABLE public.highlights
    DROP CONSTRAINT ck_highlights_owner,
    DROP CONSTRAINT fk_highlights_editions_edition_id,
    DROP CONSTRAINT fk_highlights_user_books_user_book_id,
    ADD CONSTRAINT fk_highlights_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_highlights_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE SET NULL;
