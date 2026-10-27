-- Undoes 0010_drop_lint_results: recreates the table empty, as 0000_baseline has it. Rows come from a
-- backup or a re-ingest with the code before #975 (see the up header).

SET LOCAL lock_timeout = '5s';

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
ALTER TABLE ONLY public.lint_results
    ADD CONSTRAINT fk_lint_results_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE;
