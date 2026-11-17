# The migrator: psql + database/ (ADR-026, ADR-030). No .NET: migrations are plain SQL files that
# database/migrate.sh applies; database/run.sh creates the database first when it is missing.
# Base image pinned by digest (tag kept for humans); Dependabot moves it.
# postgresql16-client matches the server's major version (pgvector/pgvector:pg16).
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache postgresql16-client
COPY database/migrate.sh database/run.sh /database/
COPY database/migrations/ /database/migrations/
# Non-root; the image needs no writable path.
USER nobody
# `docker compose run --rm migrator down 3` replaces CMD; a plain `up -d` runs `up`.
ENTRYPOINT ["sh", "/database/run.sh"]
CMD ["up"]
