-- Undoes 0003_drop_vocabulary_words_user_site_index: recreates the index as 0000_baseline has it.

CREATE INDEX ix_vocabulary_words_user_id_site_id ON public.vocabulary_words USING btree (user_id, site_id);
