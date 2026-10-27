-- Undoes 0005_drop_notes: recreates the table empty, as 0000_baseline has it. Rows come from a
-- backup (see the up header); there were none.

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
