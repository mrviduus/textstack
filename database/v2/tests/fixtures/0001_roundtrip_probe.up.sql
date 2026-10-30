-- 0001_roundtrip_probe — a migration that exists only for tests/roundtrip.sh step 5
--
-- What:  one table, created and dropped again inside the test run.
-- Why:   the V2 baseline has no down file, so without this the runner's down path would be
--        unexercised for textstack_v2 until the first real migration.
-- Issue: https://github.com/mrviduus/textstack/issues/1014
-- Compatibility: never applied to a real database — it lives under tests/, not migrations/.
-- Down:  0001_roundtrip_probe.down.sql drops the table, leaving the baseline schema exactly.

CREATE TABLE public.roundtrip_probe (
    id uuid NOT NULL,
    CONSTRAINT pk_roundtrip_probe PRIMARY KEY (id)
);
