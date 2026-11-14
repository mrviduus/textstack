-- 0006_page_name_scheme — is_locator() takes the page-name scheme (ADR-031 "Amended 2026-11-13")
--
-- What:  public.is_locator() accepts 'page-name' beside the four schemes it had; everything else it
--          checks is unchanged (a quote still only on epub-cfi).
-- Why:   owner 2026-11-13: a page-based position (a CBZ image, later a fixed-layout EPUB page, #1196)
--          is its own scheme, {"page":"<stable page key>","index":N}, not a quote-less epub-cfi. The
--          value is checked by the application (SyncValidation.Locator), the scheme against the file
--          by it and by ReadingStateRepository's write SQL (page-name only on a cbz).
-- Issue: https://github.com/mrviduus/textstack/issues/1188
-- Compatibility: the function only widens, so every stored locator stays valid and no CHECK fails.
--                CREATE OR REPLACE keeps the function's oid: the three CHECKs that call it keep
--                working. Deploy the migration before the code (the API would otherwise get 23514
--                on a page-name write; it validates first, so a misordered deploy fails loud).
-- Down:  0006_page_name_scheme.down.sql restores the baseline's list. It fails, on purpose, while any
--        reading_state or annotations row holds a page-name locator: the CHECKs are not re-run by a
--        function swap, so those rows would silently stop satisfying their constraints. Clear them
--        first (a reading position is re-sent by the client's next page turn).

CREATE OR REPLACE FUNCTION public.is_locator(locator jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    RETURN jsonb_typeof(locator) = 'object'
        AND locator -> 'version' = '1'
        AND locator ->> 'scheme' IN ('epub-cfi', 'pdf-page', 'page-name', 'textstack-position-v1', 'textstack-anchor-v1')
        -- A missing value, or an explicit null: neither is a position.
        AND locator ? 'value'
        AND jsonb_typeof(locator -> 'value') <> 'null'
        AND (NOT locator ? 'quote'
             OR (locator ->> 'scheme' = 'epub-cfi'
                 AND jsonb_typeof(locator -> 'quote') = 'string'
                 AND length(locator ->> 'quote') BETWEEN 1 AND 64));
