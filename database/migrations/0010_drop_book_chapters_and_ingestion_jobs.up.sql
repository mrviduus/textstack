-- 0010_drop_book_chapters_and_ingestion_jobs — the server's extracted chapters and its extraction queue go (ADR-033 P5)
--
-- What:  DROP TABLE public.book_chapters and public.ingestion_jobs, with their rows; COMMENT ON COLUMN
--          book_files.toc, now the only table of contents the server holds.
-- Why:   ADR-033: the client is the only parser. The reader syncs a file's TOC to book_files.toc (P3),
--          every chapter-key check and the assistant read it (P4), and the extraction worker, its
--          repositories and the TextStack.Extraction library are deleted (P5, the two releases before
--          this one). Nothing reads or writes either table.
-- Issue: https://github.com/mrviduus/textstack/issues/1525
-- Compatibility: the code deployed now (P5 steps 1-2) names neither table. The Api counts this file for
--                readiness, so /me/v2 answers 503 until it is applied; compose runs the migrator before
--                api and worker. Older code (before P5 step 1) still reads book_chapters: deploy those
--                first.
-- Down:  0010_drop_book_chapters_and_ingestion_jobs.down.sql recreates both tables EMPTY, as 0000, 0001,
--        0005 and 0008 left them, and removes the toc comment. The chapter text and the job history are
--        lost; they come back only from a backup taken before this ran (deploy.yml dumps one first).

DROP TABLE public.book_chapters;
DROP TABLE public.ingestion_jobs;

COMMENT ON COLUMN public.book_files.toc IS
    'The reader-synced table of contents (ADR-033): a JSON array of {key, title, depth, fraction}, written by PUT .../files/{fileId}/toc; null until a reader opens the file. The server parses no book, so this is the only TOC it holds.';
