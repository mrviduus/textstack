-- Undoes 0008_transitional_table_comments: the baseline's comments, as 0000 wrote them.

COMMENT ON TABLE public.book_chapters IS
    'Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031. Reading module: a server-extracted chapter of one file version.';
COMMENT ON TABLE public.ingestion_jobs IS
    'Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031. Library module: a server extraction job for one uploaded file.';
