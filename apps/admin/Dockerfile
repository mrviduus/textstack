# Admin SPA: built with pnpm in one stage, served as static files from nginx in the
# next. The runtime image holds dist/ and nginx — no Node, no node_modules.
#
# Before this, the image was the build stage itself running `vite preview`, and it
# shipped the full workspace install (mobile's dependencies included, since the
# workspace hoists) to serve a few hundred KB of static files. Earlier still it ran
# `vite dev` in prod; see git history for why that went.
#
# Builds from the repository root, not from apps/admin. A pnpm workspace has one
# lockfile, and `catalog:` specifiers cannot be resolved without
# pnpm-workspace.yaml in scope.
#
# Base images are pinned by digest (tag kept for humans); Dependabot moves them.
# The node tag must match .nvmrc — a Dockerfile cannot read it, so
# scripts/check-node-version.mjs fails CI when they drift.
FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build

WORKDIR /repo

# pnpm version comes from `packageManager` in the root package.json.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN corepack enable && corepack prepare --activate

# Every workspace member's manifest: --frozen-lockfile validates against all of
# them. Manifests only, so the install layer is not invalidated by a source edit.
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY packages/reader-overlay/package.json packages/reader-overlay/
COPY packages/reader-engine/package.json packages/reader-engine/

# node-linker=isolated: the workspace is hoisted for Metro's sake (pnpm-workspace.yaml),
# and a hoisted install does not honour --filter — it lays out every member's tree.
# Isolated installs only admin's. Nothing from this stage reaches the runtime image
# except dist/, but a smaller install is a faster build.
# The build repeats the flag: pnpm checks the install before running a script, and
# a linker that differs from the workspace setting reads as a stale install.
RUN pnpm install --frozen-lockfile --filter textstack-admin... --config.node-linker=isolated

COPY apps/admin/ ./apps/admin/
COPY packages/ ./packages/

# VITE_API_URL must be set at BUILD time — `vite build` bakes import.meta.env.*
# into the bundle. `/api` is relative; host nginx proxies it to the API.
ENV VITE_API_URL=/api
RUN pnpm --filter textstack-admin --config.node-linker=isolated build

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3

# Same contract as before: plain HTTP on :81 (compose maps 127.0.0.1:81, host nginx
# proxies textstack.dev to it), SPA fallback to index.html for client routes. Runs as
# the image's non-root nginx user; Docker allows binding <1024 inside a container.
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 81
