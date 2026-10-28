# The migrator: psql + database/ (ADR-026). No .NET: migrations are plain SQL files that
# database/migrate.sh applies. Base image pinned by digest (tag kept for humans); Dependabot moves it.
# postgresql16-client matches the server's major version (pgvector/pgvector:pg16).
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache postgresql16-client
COPY database/migrate.sh /database/migrate.sh
COPY database/migrations/ /database/migrations/
# Non-root; the image needs no writable path.
USER nobody
# `docker compose run --rm migrator down 3` replaces CMD; a plain `up -d` runs `up`.
ENTRYPOINT ["sh", "/database/migrate.sh"]
CMD ["up"]
