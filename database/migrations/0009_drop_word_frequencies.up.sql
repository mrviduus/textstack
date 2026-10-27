-- 0009_drop_word_frequencies — drop the startup copy of the embedded word-frequency file
--
-- What:  DROP TABLE word_frequencies (its 2 indexes go with it; no FKs).
-- Why:   its 20,000 rows were a copy of Application/Vocabulary/Data/wordfreq-en.json.gz, made at
--        every startup and read back whole. The previous release made FrequencyFilter read the file
--        directly and deleted the loader worker and the entity (#973).
-- Issue: https://github.com/mrviduus/textstack/issues/935
-- Compatibility: the deployed code no longer maps the table.
-- Down:  0009_drop_word_frequencies.down.sql recreates the table and indexes exactly as
--        0000_baseline has them, empty. Nothing is lost: the rows are the embedded file, and the
--        code before #973 refills the table from it on startup.

SET LOCAL lock_timeout = '5s';

DROP TABLE public.word_frequencies;
