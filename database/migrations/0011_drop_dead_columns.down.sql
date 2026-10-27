-- Undoes 0011_drop_dead_columns: re-adds the 13 columns, their indexes and FKs as 0000_baseline has
-- them, with 0008's defaults. Values are not restored (see the up header). Run this BEFORE rolling
-- the code back past #976.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ssg_rebuild_jobs
    ADD COLUMN mode character varying(20) NOT NULL DEFAULT 'Full',
    ADD COLUMN timeout_ms integer NOT NULL DEFAULT 30000,
    ADD COLUMN book_slugs_json jsonb,
    ADD COLUMN author_slugs_json jsonb,
    ADD COLUMN genre_slugs_json jsonb;

ALTER TABLE public.ingestion_jobs
    ADD COLUMN work_id uuid,
    ADD COLUMN source_edition_id uuid;
CREATE INDEX ix_ingestion_jobs_source_edition_id ON public.ingestion_jobs USING btree (source_edition_id);
CREATE INDEX ix_ingestion_jobs_work_id ON public.ingestion_jobs USING btree (work_id);
ALTER TABLE ONLY public.ingestion_jobs
    ADD CONSTRAINT fk_ingestion_jobs_editions_source_edition_id FOREIGN KEY (source_edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.ingestion_jobs
    ADD CONSTRAINT fk_ingestion_jobs_works_work_id FOREIGN KEY (work_id) REFERENCES public.works(id) ON DELETE SET NULL;

ALTER TABLE public.editions ADD COLUMN source_edition_id uuid;
CREATE INDEX ix_editions_source_edition_id ON public.editions USING btree (source_edition_id);
ALTER TABLE ONLY public.editions
    ADD CONSTRAINT fk_editions_editions_source_edition_id FOREIGN KEY (source_edition_id) REFERENCES public.editions(id) ON DELETE SET NULL;

ALTER TABLE public.seo_backfill_settings
    ADD COLUMN language_filter text[] NOT NULL DEFAULT '{}',
    ADD COLUMN entity_type_filter text[] NOT NULL DEFAULT '{}',
    ADD COLUMN ssg_rebuild_batch_minutes integer NOT NULL DEFAULT 5;

ALTER TABLE public.user_books ADD COLUMN suggested_tags_at timestamp with time zone;

ALTER TABLE public.user_ingestion_jobs ADD COLUMN units_count integer;
