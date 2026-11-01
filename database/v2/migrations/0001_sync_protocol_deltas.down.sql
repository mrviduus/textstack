-- Undoes 0001_sync_protocol_deltas: every FK, index and CHECK back as the baseline declares
-- them, then the four columns dropped — with whatever they hold.

ALTER TABLE public.book_files DROP COLUMN content_removed_at;

ALTER TABLE public.books
    DROP CONSTRAINT ck_books_revision,
    DROP COLUMN revision;

DROP INDEX public.ix_vocabulary_words_user_id_next_review_at;
CREATE INDEX ix_vocabulary_words_user_id_next_review_at
    ON public.vocabulary_words (user_id, next_review_at) WHERE deleted_at IS NULL;
ALTER TABLE public.vocabulary_words DROP COLUMN retired_at;

DROP INDEX public.ix_annotations_user_id_book_id_created_at_id;

ALTER TABLE public.book_insight DROP CONSTRAINT ck_book_insight_review_chapter;

DROP INDEX public.ix_review_question_user_id_book_insight_id_prompt_hash;
CREATE UNIQUE INDEX ix_review_question_book_insight_id_prompt_hash ON public.review_question (book_insight_id, prompt_hash);

ALTER TABLE public.ingestion_jobs
    DROP CONSTRAINT fk_ingestion_jobs_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_ingestion_jobs_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE;

ALTER TABLE public.book_chapters
    DROP CONSTRAINT fk_book_chapters_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_book_chapters_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE;

ALTER TABLE public.review_question
    DROP CONSTRAINT fk_review_question_book_insight_user_id_book_insight_id,
    ADD CONSTRAINT fk_review_question_book_insight_user_id_book_insight_id FOREIGN KEY (user_id, book_insight_id)
        REFERENCES public.book_insight (user_id, id) ON DELETE CASCADE;

ALTER TABLE public.book_insight
    DROP CONSTRAINT fk_book_insight_books_user_id_book_id,
    ADD CONSTRAINT fk_book_insight_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE;

ALTER TABLE public.discussion_checkpoints
    DROP CONSTRAINT fk_discussion_checkpoints_books_user_id_book_id,
    ADD CONSTRAINT fk_discussion_checkpoints_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE,
    DROP CONSTRAINT fk_discussion_checkpoints_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_discussion_checkpoints_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED,
    DROP CONSTRAINT fk_discussion_checkpoints_shared_chapters_shared_chapter_id,
    ADD CONSTRAINT fk_discussion_checkpoints_shared_chapters_shared_chapter_id
        FOREIGN KEY (user_id, book_id, shared_chapter_id)
        REFERENCES public.shared_chapters (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.shared_chapters
    DROP CONSTRAINT fk_shared_chapters_books_user_id_book_id,
    ADD CONSTRAINT fk_shared_chapters_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE,
    DROP CONSTRAINT fk_shared_chapters_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_shared_chapters_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.vocabulary_reviews
    DROP CONSTRAINT fk_vocabulary_reviews_vocabulary_words_user_id_word_id,
    ADD CONSTRAINT fk_vocabulary_reviews_vocabulary_words_user_id_word_id FOREIGN KEY (user_id, word_id)
        REFERENCES public.vocabulary_words (user_id, id) ON DELETE CASCADE;

ALTER TABLE public.vocabulary_examples
    DROP CONSTRAINT fk_vocabulary_examples_vocabulary_words_user_id_word_id,
    ADD CONSTRAINT fk_vocabulary_examples_vocabulary_words_user_id_word_id FOREIGN KEY (user_id, word_id)
        REFERENCES public.vocabulary_words (user_id, id) ON DELETE CASCADE,
    DROP CONSTRAINT fk_vocabulary_examples_books_user_id_book_id,
    ADD CONSTRAINT fk_vocabulary_examples_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) DEFERRABLE INITIALLY DEFERRED,
    DROP CONSTRAINT fk_vocabulary_examples_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_vocabulary_examples_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.annotations
    DROP CONSTRAINT fk_annotations_books_user_id_book_id,
    ADD CONSTRAINT fk_annotations_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE,
    DROP CONSTRAINT fk_annotations_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_annotations_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.reading_sessions
    DROP CONSTRAINT fk_reading_sessions_books_user_id_book_id,
    ADD CONSTRAINT fk_reading_sessions_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE SET NULL (book_id);

ALTER TABLE public.reading_state
    DROP CONSTRAINT fk_reading_state_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_reading_state_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE;

ALTER TABLE public.book_files
    DROP CONSTRAINT fk_book_files_books_user_id_book_id,
    ADD CONSTRAINT fk_book_files_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE;

ALTER TABLE public.reading_state
    DROP CONSTRAINT ck_reading_state_reset_revision,
    DROP COLUMN reset_revision;
