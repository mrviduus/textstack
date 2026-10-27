-- Undoes 0002_drop_redundant_indexes: recreates the 7 indexes exactly as 0000_baseline has them.

CREATE INDEX idx_editions_title_trgm ON public.editions USING gist (lower(title) public.gist_trgm_ops);
CREATE INDEX ix_book_files_sha256 ON public.book_files USING btree (sha256);
CREATE INDEX ix_book_assets_edition_id ON public.book_assets USING btree (edition_id);
CREATE INDEX ix_user_books_user_id ON public.user_books USING btree (user_id);
CREATE INDEX ix_user_chapters_user_book_id ON public.user_chapters USING btree (user_book_id);
CREATE INDEX ix_user_book_files_sha256 ON public.user_book_files USING btree (sha256);
CREATE INDEX ix_collections_user_id ON public.collections USING btree (user_id);
