-- 0013_drop_agent_run — the agent runs table goes with the agent stack (#1625)
--
-- What:  DROP TABLE public.agent_run, with its rows (production held none).
-- Why:   the agent and tool stack is deleted (#1637): nothing writes, reads, sweeps or merges an agent run.
-- Issue: https://github.com/mrviduus/textstack/issues/1625
-- Compatibility: no live code names agent_run since #1637 (deployed 2026-11-27), so the running Api is safe
--                in the deploy window. Code from before #1637 must not run against this schema (rollback:
--                migrate-down first).
-- Down:  0013_drop_agent_run.down.sql recreates the table EMPTY, as 0000 left it.

DROP TABLE public.agent_run;
