-- 0001_sync_protocol_deltas — what the sync PDD (M2.1) and the owner's decisions need from the schema
--
-- What:  nine changes, one per concern below: reading_state.reset_revision; ON UPDATE CASCADE on
--          every composite (user_id, …) FK; the share FK of discussion_checkpoints sets its column
--          null on delete; review_question's prompt index keyed by user_id; book_insight checks
--          that a review names a chapter; a partial annotations index for the list order;
--          vocabulary_words.retired_at (and the due index excludes it); books.revision;
--          book_files.content_removed_at.
-- Why:   docs/01-architecture/v2-sync-protocol.md "Changes required → In M1.2 code" item 1 and
--          "Owner decisions (2026-10-30)" 1, 5, 6, 12; the Discussion fixes M1.4 found (#1047).
-- Issue: https://github.com/mrviduus/textstack/issues/1086
-- Compatibility: textstack_v2 holds no data and nothing deployed reads it (M1.x repositories are
--                tested, not resolved). Every column added is nullable or defaulted; the one index
--                replaced keeps its uniqueness; no row can be refused by the new CHECKs because
--                there are none.
-- Down:  0001_sync_protocol_deltas.down.sql puts every FK, index and CHECK back as the baseline
--        had them and drops the five columns — with whatever they hold.

-- ===== Reading: a reset is distinguishable from a move =====

-- The revision a reset produced. A stale writer whose expected revision is below it lost to a
-- reset, not to another device moving on; the PDD's 409 body says which (M1.2 delta 1).
ALTER TABLE public.reading_state
    ADD COLUMN reset_revision bigint,
    ADD CONSTRAINT ck_reading_state_reset_revision CHECK (reset_revision BETWEEN 1 AND revision);

-- ===== Merge: ON UPDATE CASCADE on every composite (user_id, …) FK =====

-- The guest→account merge reparents a guest's rows with UPDATE … SET user_id (owner decision 12):
-- with global PKs and cascading deletes, an insert-move-delete form could not be built (PDD "Bug
-- Report"). The cascade only follows the key; uniqueness collisions and ownership are the merge's
-- own checks. ON DELETE and deferral stay exactly as the baseline had them.
ALTER TABLE public.book_files
    DROP CONSTRAINT fk_book_files_books_user_id_book_id,
    ADD CONSTRAINT fk_book_files_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.reading_state
    DROP CONSTRAINT fk_reading_state_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_reading_state_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.reading_sessions
    DROP CONSTRAINT fk_reading_sessions_books_user_id_book_id,
    ADD CONSTRAINT fk_reading_sessions_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE SET NULL (book_id) ON UPDATE CASCADE;

ALTER TABLE public.annotations
    DROP CONSTRAINT fk_annotations_books_user_id_book_id,
    ADD CONSTRAINT fk_annotations_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
    DROP CONSTRAINT fk_annotations_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_annotations_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.vocabulary_examples
    DROP CONSTRAINT fk_vocabulary_examples_vocabulary_words_user_id_word_id,
    ADD CONSTRAINT fk_vocabulary_examples_vocabulary_words_user_id_word_id FOREIGN KEY (user_id, word_id)
        REFERENCES public.vocabulary_words (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
    DROP CONSTRAINT fk_vocabulary_examples_books_user_id_book_id,
    ADD CONSTRAINT fk_vocabulary_examples_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
    DROP CONSTRAINT fk_vocabulary_examples_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_vocabulary_examples_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.vocabulary_reviews
    DROP CONSTRAINT fk_vocabulary_reviews_vocabulary_words_user_id_word_id,
    ADD CONSTRAINT fk_vocabulary_reviews_vocabulary_words_user_id_word_id FOREIGN KEY (user_id, word_id)
        REFERENCES public.vocabulary_words (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.shared_chapters
    DROP CONSTRAINT fk_shared_chapters_books_user_id_book_id,
    ADD CONSTRAINT fk_shared_chapters_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
    DROP CONSTRAINT fk_shared_chapters_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_shared_chapters_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- The share FK also gains ON DELETE SET NULL (shared_chapter_id): deleting a share leaves its
-- checkpoints, text and all, with no link — one DELETE, no unlink statement and no lock around it.
-- An append holds the share FOR KEY SHARE until it commits, so the delete waits for it and the
-- cascade sees that checkpoint too.
ALTER TABLE public.discussion_checkpoints
    DROP CONSTRAINT fk_discussion_checkpoints_books_user_id_book_id,
    ADD CONSTRAINT fk_discussion_checkpoints_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
    DROP CONSTRAINT fk_discussion_checkpoints_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_discussion_checkpoints_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
    DROP CONSTRAINT fk_discussion_checkpoints_shared_chapters_shared_chapter_id,
    ADD CONSTRAINT fk_discussion_checkpoints_shared_chapters_shared_chapter_id
        FOREIGN KEY (user_id, book_id, shared_chapter_id)
        REFERENCES public.shared_chapters (user_id, book_id, id)
        ON DELETE SET NULL (shared_chapter_id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.book_insight
    DROP CONSTRAINT fk_book_insight_books_user_id_book_id,
    ADD CONSTRAINT fk_book_insight_books_user_id_book_id FOREIGN KEY (user_id, book_id)
        REFERENCES public.books (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.review_question
    DROP CONSTRAINT fk_review_question_book_insight_user_id_book_insight_id,
    ADD CONSTRAINT fk_review_question_book_insight_user_id_book_insight_id FOREIGN KEY (user_id, book_insight_id)
        REFERENCES public.book_insight (user_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.book_chapters
    DROP CONSTRAINT fk_book_chapters_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_book_chapters_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.ingestion_jobs
    DROP CONSTRAINT fk_ingestion_jobs_book_files_user_id_book_id_file_id,
    ADD CONSTRAINT fk_ingestion_jobs_book_files_user_id_book_id_file_id FOREIGN KEY (user_id, book_id, file_id)
        REFERENCES public.book_files (user_id, book_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== Discussion: ownership in the prompt key; a review is of one chapter =====

-- Ownership in the key (ADR-031 rule 2): the upsert's conflict target then cannot meet another
-- user's question, so the repository needs no second owner guard.
DROP INDEX public.ix_review_question_book_insight_id_prompt_hash;
CREATE UNIQUE INDEX ix_review_question_user_id_book_insight_id_prompt_hash
    ON public.review_question (user_id, book_insight_id, prompt_hash);

-- A chapter review is always of one chapter (ADR-016); until now only the repository said so.
ALTER TABLE public.book_insight
    ADD CONSTRAINT ck_book_insight_review_chapter CHECK (review_json IS NULL OR chapter_slug IS NOT NULL);

-- ===== Annotations: the list order, live rows only =====

-- ListForBookAsync reads live annotations of one book in (created_at, id) order; (user_id, book_id)
-- alone covers neither the order nor the tombstone filter. The old index stays for the FK cascade
-- and for reads that include tombstones.
CREATE INDEX ix_annotations_user_id_book_id_created_at_id
    ON public.annotations (user_id, book_id, created_at, id) WHERE deleted_at IS NULL;

-- ===== Vocabulary: a mastered word is retired, not deleted =====

-- Owner decision 1: retiring keeps the card and its key; only an explicit delete makes a tombstone.
-- A retired card leaves the review queue, so the due index excludes it too.
ALTER TABLE public.vocabulary_words ADD COLUMN retired_at timestamptz;
DROP INDEX public.ix_vocabulary_words_user_id_next_review_at;
CREATE INDEX ix_vocabulary_words_user_id_next_review_at
    ON public.vocabulary_words (user_id, next_review_at) WHERE deleted_at IS NULL AND retired_at IS NULL;

-- ===== Library: revision-guarded metadata; a file whose bytes were withdrawn =====

-- Owner decision 5: a metadata edit names the revision it read, like a reading-state write; no
-- unguarded last-writer-wins anywhere a client edits.
ALTER TABLE public.books
    ADD COLUMN revision bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT ck_books_revision CHECK (revision > 0);

-- Owner decision 6, "stop syncing this file": the server's bytes are deleted and the row says so,
-- so no client re-uploads its local copy on its own. Metadata and reading data stay.
ALTER TABLE public.book_files ADD COLUMN content_removed_at timestamptz;
