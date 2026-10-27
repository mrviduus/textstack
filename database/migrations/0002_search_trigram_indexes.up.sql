-- 0002_search_trigram_indexes — GIN trigram indexes for title and author search
--
-- What:  editions.lower(title) trigram index GiST → GIN; new GIN trigram index on authors.lower(name).
-- Why:   EF migration 20260219000000_AddSearchPerformanceIndexes had no .Designer.cs and never ran.
--        Search's `lower(title) LIKE '%q%'` and `lower(name) LIKE '%q%'` can use a GIN trigram index;
--        GIN is the faster of the two for reads. Its third index, editions (site_id, status), is not
--        added: site_id goes with #946.
-- Issue: https://github.com/mrviduus/textstack/issues/948
-- Compatibility: indexes only; no query or code changes. Plain CREATE INDEX locks writes on the two
--        tables for the build: editions and authors are small (725 authors).
-- Down:  0002_search_trigram_indexes.down.sql drops both and puts the GiST index back.

DROP INDEX public.idx_editions_title_trgm;
CREATE INDEX idx_editions_title_trgm ON public.editions USING gin (lower(title) public.gin_trgm_ops);
CREATE INDEX idx_authors_name_trgm ON public.authors USING gin (lower(name) public.gin_trgm_ops);
