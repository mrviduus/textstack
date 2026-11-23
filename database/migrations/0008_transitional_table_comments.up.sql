-- 0008_transitional_table_comments — book_chapters / ingestion_jobs comments say what is true now
--
-- What:  COMMENT ON TABLE book_chapters and ingestion_jobs, replacing "Dropped at M6.4".
-- Why:   M6 kept both tables (owner decision D8, ADR-031 amended 2026-11-17): the MCP chapter tools and
--          clip extraction read them. They go in ADR-033's last phase, not at M6.4.
-- Issue: https://github.com/mrviduus/textstack/issues/1417
-- Compatibility: comments only; nothing reads them.
-- Down:  0008_transitional_table_comments.down.sql restores the baseline's comments.

COMMENT ON TABLE public.book_chapters IS
    'Transitional. Kept at M6 (D8, ADR-031 amended 2026-11-17) for the MCP chapter tools and clips; dropped in ADR-033''s last phase. Reading module: a server-extracted chapter of one file version.';
COMMENT ON TABLE public.ingestion_jobs IS
    'Transitional. Kept at M6 (D8, ADR-031 amended 2026-11-17) with the extraction worker; dropped in ADR-033''s last phase. Library module: a server extraction job for one uploaded file.';
