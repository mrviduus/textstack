-- Undoes 0006_page_name_scheme: is_locator() takes the baseline's four schemes again. Fails closed: a
-- reading_state or annotations row holding a page-name locator raises below, with the counts, before
-- anything changes. A function swap re-runs no CHECK, so without this those rows would stay, now
-- breaking constraints nothing reports. Nothing is deleted here: which positions may go is a human's call.

DO $$
DECLARE
    states bigint := (SELECT count(*) FROM public.reading_state
        WHERE current_locator ->> 'scheme' = 'page-name' OR frontier_locator ->> 'scheme' = 'page-name');
    notes bigint := (SELECT count(*) FROM public.annotations WHERE locator ->> 'scheme' = 'page-name');
BEGIN
    IF states > 0 OR notes > 0 THEN
        RAISE EXCEPTION '0006 down refused: % reading_state row(s), % annotations row(s) hold a page-name locator; clear them first', states, notes;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.is_locator(locator jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    RETURN jsonb_typeof(locator) = 'object'
        AND locator -> 'version' = '1'
        AND locator ->> 'scheme' IN ('epub-cfi', 'pdf-page', 'textstack-position-v1', 'textstack-anchor-v1')
        -- A missing value, or an explicit null: neither is a position.
        AND locator ? 'value'
        AND jsonb_typeof(locator -> 'value') <> 'null'
        AND (NOT locator ? 'quote'
             OR (locator ->> 'scheme' = 'epub-cfi'
                 AND jsonb_typeof(locator -> 'quote') = 'string'
                 AND length(locator ->> 'quote') BETWEEN 1 AND 64));
