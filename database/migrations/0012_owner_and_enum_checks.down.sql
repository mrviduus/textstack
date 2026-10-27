-- Undoes 0012_owner_and_enum_checks: drops the CHECKs and the unique index and restores the plain
-- index exactly as 0000_baseline has it. No data changes.

SET LOCAL lock_timeout = '5s';

DROP INDEX public.ix_seo_templates_entity_type_field_type_language_code;
CREATE INDEX ix_seo_templates_entity_type_field_type_language_code_is_active ON public.seo_templates USING btree (entity_type, field_type, language_code, is_active);

ALTER TABLE public.book_collections DROP CONSTRAINT ck_book_collections_book_type;
ALTER TABLE public.book_quality_jobs DROP CONSTRAINT ck_book_quality_jobs_owner;
ALTER TABLE public.reading_sessions DROP CONSTRAINT ck_reading_sessions_owner;
ALTER TABLE public.highlights DROP CONSTRAINT ck_highlights_owner;
