-- 0012_drop_review_question — the chapter-review self-check questions go (#1624)
--
-- What:  DROP TABLE public.review_question, with its rows.
-- Why:   chapter reviews are retired: no endpoint, MCP tool or worker writes or reads a review question.
--          Its repository is deleted, and the guest→account merge no longer folds a losing insight's
--          questions into its checkpoint. Nothing names the table.
-- Issue: https://github.com/mrviduus/textstack/issues/1624
-- Compatibility: no live code names review_question since #1636 (deployed 2026-11-27), so the running Api is
--                safe in the deploy window. The Api counts this file for readiness, so /me/v2 answers 503
--                until it is applied; compose runs the migrator before api and worker. Code from before
--                #1636 must not run against this schema (rollback: migrate-down first).
-- Down:  0012_drop_review_question.down.sql recreates the table EMPTY, as 0000 and 0001 left it. Its rows
--        are lost; they come back only from a backup taken before this ran (deploy.yml dumps one first).

DROP TABLE public.review_question;
