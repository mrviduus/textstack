-- 0007_drop_shadow_runs — drop the never-written shadow-model comparison table
--
-- What:  DROP TABLE shadow_runs (its 2 indexes and its FK to users go with it).
-- Why:   shadow routing was never switched on (no Ai:Shadow routes, sample rate 0), so the table
--        stayed empty. The previous release removed the shadow path, its writer, admin tab and
--        retention sweep (#972). The model registry (models, model_promotions) stays.
-- Issue: https://github.com/mrviduus/textstack/issues/934
-- Compatibility: the deployed code no longer maps the table. Locks it first, then refuses to run if
--        it holds a row, so nothing is dropped that someone wrote. Dropping the FK briefly locks
--        users too; past the 5 s timeout it aborts with nothing changed, and is rerun.
-- Down:  0007_drop_shadow_runs.down.sql recreates the table, indexes and FK exactly as
--        0000_baseline has them, empty. There were 0 rows; any data would come from the
--        pre-deploy dump (~/backups/textstack/pre-deploy-*) or a nightly backup.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.shadow_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.shadow_runs) THEN
        RAISE EXCEPTION 'shadow_runs is not empty; refusing to drop it (#934)';
    END IF;
END $$;

DROP TABLE public.shadow_runs;
