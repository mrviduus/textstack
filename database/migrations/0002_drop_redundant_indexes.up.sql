-- 0002_drop_redundant_indexes — drop indexes no query needs
--
-- What:  drops 7 indexes:
--          left prefix of another index on the same table (that index serves the same lookups):
--            ix_book_assets_edition_id      ⊂ ix_book_assets_edition_id_original_path
--            ix_collections_user_id         ⊂ ix_collections_user_id_sort_order
--            ix_user_books_user_id          ⊂ ix_user_books_user_id_slug
--            ix_user_chapters_user_book_id  ⊂ ix_user_chapters_user_book_id_chapter_number
--          no query filters by the column:
--            ix_book_files_sha256, ix_user_book_files_sha256
--          no query can use it (#948: search's LIKE … OR EXISTS and similarity() > x never pick it):
--            idx_editions_title_trgm
-- Why:   each index costs on every write and in the backup; these serve nothing.
-- Issue: https://github.com/mrviduus/textstack/issues/938
-- Compatibility: indexes only; queries keep the same plans or use the wider index.
--        The site_id-prefixed vocabulary_words index goes with #946.
-- Down:  0002_drop_redundant_indexes.down.sql recreates all 7 exactly as 0000_baseline has them.

DROP INDEX public.ix_book_assets_edition_id;
DROP INDEX public.ix_collections_user_id;
DROP INDEX public.ix_user_books_user_id;
DROP INDEX public.ix_user_chapters_user_book_id;
DROP INDEX public.ix_book_files_sha256;
DROP INDEX public.ix_user_book_files_sha256;
DROP INDEX public.idx_editions_title_trgm;
