-- 0004_drop_book_files_sha256 — drop the never-read hash of catalog uploads
--
-- What:  ALTER TABLE book_files DROP COLUMN sha256.
-- Why:   written on admin upload, read by nothing (no query, no export, no script). The previous
--        release stopped writing it and removed it from the EF model (#966).
-- Issue: https://github.com/mrviduus/textstack/issues/937
-- Compatibility: the deployed code no longer maps the column. Its index went in 0002.
-- Down:  0004_drop_book_files_sha256.down.sql re-adds the column (nullable, as before) empty: the
--        hashes of the 22 existing rows are not restored; nothing reads them. If wanted: the
--        pre-deploy dump deploy.yml takes right before this runs (~/backups/textstack/pre-deploy-*;
--        it keeps the last two) or a nightly backup.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.book_files DROP COLUMN sha256;
