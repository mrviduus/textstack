-- 0012_drop_review_question_and_agent_run — two tables of retired features go (#1624, #1625)
--
-- What:  DROP TABLE public.review_question and public.agent_run, with their rows.
-- Why:   chapter reviews are retired: no endpoint, MCP tool or worker writes or reads a review question
--          (its repository and its merge step went in #1636). The agent and tool stack is deleted
--          (#1625): nothing writes an agent run, so its retention sweep and its guest-merge move go too.
-- Issue: https://github.com/mrviduus/textstack/issues/1625
-- Compatibility: review_question: deploy with or after the code that stopped reading the table (#1636,
--                already live). agent_run: the code shipped with this file names it nowhere; older code
--                still moves agent runs in a guest merge and sweeps them in retention, so it must not run
--                against this schema (compose runs the migrator before api and worker). The Api counts
--                this file for readiness, so /me/v2 answers 503 until it is applied.
-- Down:  0012_drop_review_question_and_agent_run.down.sql recreates both tables EMPTY, as 0000 and 0001
--        left them. Their rows are lost; they come back only from a backup taken before this ran
--        (deploy.yml dumps one first).

DROP TABLE public.review_question;
DROP TABLE public.agent_run;
