-- Undoes 0010_drop_book_chapters_and_ingestion_jobs: both tables back, EMPTY, as 0000, 0001 (FKs follow an
-- UPDATE of user_id), 0005 (source_format list) and 0008 (comments) left them; book_files.toc loses its comment.
-- Their rows are not restored: the chapter text and the job history come only from a backup taken before 0010.

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
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX ix_book_chapters_user_id_book_id_file_id_chapter_number ON public.book_chapters (user_id, book_id, file_id, chapter_number);
COMMENT ON TABLE public.book_chapters IS
    'Transitional. Kept at M6 (D8, ADR-031 amended 2026-11-17) for the MCP chapter tools and clips; dropped in ADR-033''s last phase. Reading module: a server-extracted chapter of one file version.';

CREATE TABLE public.ingestion_jobs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    book_id uuid NOT NULL,
    file_id uuid NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL,
    error text,
    source_format text,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT pk_ingestion_jobs PRIMARY KEY (id),
    CONSTRAINT ck_ingestion_jobs_status CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
    CONSTRAINT ck_ingestion_jobs_source_format
        CHECK (source_format IN ('epub', 'pdf', 'html', 'fb2', 'mobi', 'azw3', 'cbz', 'unknown')),
    CONSTRAINT fk_ingestion_jobs_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX ix_ingestion_jobs_status ON public.ingestion_jobs (status);
CREATE INDEX ix_ingestion_jobs_created_at ON public.ingestion_jobs (created_at);
CREATE INDEX ix_ingestion_jobs_user_id_book_id_file_id ON public.ingestion_jobs (user_id, book_id, file_id);
COMMENT ON TABLE public.ingestion_jobs IS
    'Transitional. Kept at M6 (D8, ADR-031 amended 2026-11-17) with the extraction worker; dropped in ADR-033''s last phase. Library module: a server extraction job for one uploaded file.';

COMMENT ON COLUMN public.book_files.toc IS NULL;
