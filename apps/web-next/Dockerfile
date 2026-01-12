# Build stage - generates static files
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build args for API URL (passed at build time)
ARG API_URL=http://api:8080
ARG SITE_HOST=general.localhost
ARG STORAGE_URL=http://localhost:8080/storage

ENV API_URL=${API_URL}
ENV SITE_HOST=${SITE_HOST}
ENV STORAGE_URL=${STORAGE_URL}

# Build static site
RUN pnpm build

# Output stage - just the static files
FROM alpine:latest AS output
WORKDIR /app
COPY --from=builder /app/out ./out

# Default command shows what was built
CMD ["ls", "-la", "/app/out"]
