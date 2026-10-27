-- 0003_drop_vocabulary_words_user_site_index — drop a left-prefix index on vocabulary_words
--
-- What:  DROP INDEX ix_vocabulary_words_user_id_site_id.
-- Why:   (user_id, site_id) is the left prefix of ix_vocabulary_words_user_id_site_id_word_language
--        (unique) and of the review-queue index; either serves the same lookups. Same rule as 0002.
-- Issue: https://github.com/mrviduus/textstack/issues/938
-- Compatibility: index only; the wider indexes take its queries.
-- Down:  0003_drop_vocabulary_words_user_site_index.down.sql recreates it as 0000_baseline has it.

SET LOCAL lock_timeout = '5s';

DROP INDEX public.ix_vocabulary_words_user_id_site_id;
