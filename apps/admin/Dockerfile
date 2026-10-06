# Build static admin assets at image-build time, serve them via `vite preview`.
#
# Previously this Dockerfile ran `pnpm dev` (Vite dev server) in prod. That meant every
# request hit vite's on-the-fly transformer, and every container rebuild ran
# `pnpm install` without a lockfile — any unbounded version drift in vite or
# @vitejs/plugin-react could surface as "Failed to parse source for import analysis"
# (the error overlay even mis-attributed the failing file to the Dockerfile). Building
# at image-build time pins behavior to whatever `vite build` produced, and `vite
# preview` just serves the result.
#
# Builds from the repository root, not from apps/admin. A pnpm workspace has one
# lockfile, and `catalog:` specifiers cannot be resolved without
# pnpm-workspace.yaml in scope, so an image built from apps/admin alone can no
# longer install anything.

# Keep in step with .nvmrc — a Dockerfile cannot read it, so
# scripts/check-node-version.mjs fails CI when they drift.
ARG NODE_VERSION=24.20.0
FROM node:${NODE_VERSION}-alpine

WORKDIR /repo

# pnpm version comes from `packageManager` in the root package.json. This file
# used to pin pnpm@9.15.0 by hand, with a comment explaining that a loose
# `pnpm@9` had let corepack drift across rebuilds — the same problem, now
# solved once for every image instead of per Dockerfile.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN corepack enable && corepack prepare --activate

# Every workspace member's manifest: --frozen-lockfile validates against all of
# them. Manifests only, so the install layer is not invalidated by a source edit.
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY packages/reader-overlay/package.json packages/reader-overlay/

# --frozen-lockfile: fail the build if a package.json drifted from the lockfile
# instead of silently updating. Catches dep changes that weren't reviewed
# locally, and removes the class of "different rebuild → different versions"
# bugs that surfaced when this container ran `vite dev` in prod.
#
# The pnpm store is deleted in the same layer: the image is published (images.yml),
# and the store holds every package again under hash names — including
# expo-updates' test-fixture private keys, which no scanner allowlist can then
# tell apart from a real key. node_modules is hard-linked from it, so it survives.
RUN pnpm install --frozen-lockfile --filter textstack-admin... \
    && rm -rf "$(pnpm store path)"

COPY apps/admin/ ./apps/admin/
COPY packages/ ./packages/

# VITE_API_URL must be set at BUILD time — `vite build` bakes import.meta.env.*
# into the JS bundle. Setting it at container runtime via docker-compose
# `environment:` is too late; build already used the fallback default and
# burned `http://localhost:8080` into the bundle, which the browser then
# tried to call directly (ERR_CONNECTION_REFUSED). `/api` is a relative
# path → nginx handles the proxy upstream in production.
ENV VITE_API_URL=/api
RUN pnpm --filter textstack-admin build

WORKDIR /repo/apps/admin
EXPOSE 81
CMD ["pnpm", "exec", "vite", "preview", "--host", "0.0.0.0", "--port", "81"]
