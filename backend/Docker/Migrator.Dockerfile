# The migrator: psql + database/ (ADR-026). No .NET: migrations are plain SQL files that
# database/migrate.sh applies. Base image pinned by digest (tag kept for humans); Dependabot moves it.
# postgresql16-client matches the server's major version (pgvector/pgvector:pg16).
FROM alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
RUN apk add --no-cache postgresql16-client
COPY database/migrate.sh /database/migrate.sh
COPY database/migrations/ /database/migrations/
# Non-root; the image needs no writable path.
USER nobody
# `docker compose run --rm migrator down 3` replaces CMD; a plain `up -d` runs `up`.
ENTRYPOINT ["sh", "/database/migrate.sh"]
CMD ["up"]
