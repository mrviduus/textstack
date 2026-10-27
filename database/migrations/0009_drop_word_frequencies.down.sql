-- Undoes 0009_drop_word_frequencies: recreates the table empty, as 0000_baseline has it. The code
-- before #973 refills it from the embedded file on startup.

SET LOCAL lock_timeout = '5s';

CREATE TABLE public.word_frequencies (
    id uuid NOT NULL,
    language character varying(8) NOT NULL,
    word character varying(200) NOT NULL,
    rank integer NOT NULL,
    zipf double precision NOT NULL,
    pos character varying(20)
);
ALTER TABLE ONLY public.word_frequencies
    ADD CONSTRAINT pk_word_frequencies PRIMARY KEY (id);
CREATE INDEX ix_word_frequencies_language_rank ON public.word_frequencies USING btree (language, rank);
CREATE UNIQUE INDEX ix_word_frequencies_language_word ON public.word_frequencies USING btree (language, word);
