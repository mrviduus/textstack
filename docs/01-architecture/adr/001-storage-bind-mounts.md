# ADR-001: Storage via Host Bind Mounts

**Status**: Accepted — still in force (2026-10-04): `docker-compose.yml` bind-mounts `./data/storage:/storage` into `api` and `worker`.
**Date**: 2024-12

## Context

Book files (EPUB, PDF, FB2) must persist beyond container lifecycle. Options:
1. Docker volumes
2. Host bind mounts
3. Object storage (S3/MinIO)
4. Database BLOBs

## Decision

Use **host filesystem bind mounts** at `/srv/books/storage`.

Layout:
```
/srv/books/storage/books/{editionId}/original/{filename}.epub
/srv/books/storage/books/{editionId}/derived/cover.jpg
```

DB stores paths only, not binary content.

## Consequences

### Pros
- Files visible via SSH for debugging
- Simple backups (tar, rsync)
- Survives Docker restart/crash/container deletion
- No vendor lock-in

### Cons
- Not cloud-native
- Requires manual host setup
- No built-in replication

## Notes

- Containers mount: `/srv/books/storage:/storage`
- First-time setup: `sudo mkdir -p /srv/books/storage && sudo chown -R $USER /srv/books`
- S3/MinIO migration planned for production scale
