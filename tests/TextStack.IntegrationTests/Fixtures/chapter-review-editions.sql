-- Test data for ChapterReviewEndpointTests: catalog editions it can review on.
--
-- The test needs an edition with at least three slugged chapters, found at /books?offset=5 (away
-- from the first edition, which InsightsEndpointTests writes plain insights on). The baseline seed
-- has 4 editions with 2 chapters each, so without this the whole class skips — green with the
-- review round trip untested. Adds 7 copies of the first seeded edition, 3 chapters each.
--
-- Test databases only (CI's integration job loads it; locally see CLAUDE.md). Idempotent.
--   docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"' \
--     < tests/TextStack.IntegrationTests/Fixtures/chapter-review-editions.sql

DO $$
DECLARE
    src uuid := (SELECT e.id FROM editions e WHERE EXISTS (SELECT 1 FROM chapters c WHERE c.edition_id = e.id) ORDER BY e.id LIMIT 1);
    w uuid;
    e uuid;
BEGIN
    IF src IS NULL THEN RAISE EXCEPTION 'no seeded edition with chapters to copy'; END IF;
    IF EXISTS (SELECT 1 FROM editions WHERE slug LIKE '%-review-seed-%') THEN RETURN; END IF;

    FOR i IN 1..7 LOOP
        w := gen_random_uuid();
        e := gen_random_uuid();

        CREATE TEMP TABLE t ON COMMIT DROP AS SELECT * FROM works WHERE id = (SELECT work_id FROM editions WHERE id = src);
        UPDATE t SET id = w, slug = slug || '-review-seed-' || i;
        INSERT INTO works SELECT * FROM t;
        DROP TABLE t;

        CREATE TEMP TABLE t ON COMMIT DROP AS SELECT * FROM editions WHERE id = src;
        UPDATE t SET id = e, work_id = w, slug = slug || '-review-seed-' || i, title = title || ' (review seed ' || i || ')';
        INSERT INTO editions SELECT * FROM t;
        DROP TABLE t;

        FOR n IN 1..3 LOOP
            CREATE TEMP TABLE t ON COMMIT DROP AS
                SELECT * FROM chapters WHERE edition_id = src ORDER BY chapter_number LIMIT 1;
            UPDATE t SET id = gen_random_uuid(), edition_id = e, chapter_number = n,
                         slug = n || '-chapter-' || n, title = 'Chapter ' || n;
            INSERT INTO chapters SELECT * FROM t;
            DROP TABLE t;
        END LOOP;
    END LOOP;
END $$;
