-- Undoes 0002_search_trigram_indexes: drops the author index and restores the GiST title index
-- exactly as 0000_baseline has it.

DROP INDEX public.idx_authors_name_trgm;
DROP INDEX public.idx_editions_title_trgm;
CREATE INDEX idx_editions_title_trgm ON public.editions USING gist (lower(title) public.gist_trgm_ops);
