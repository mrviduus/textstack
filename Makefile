.PHONY: up down restart logs status migrate migrate-down migrate-status migrate-drop migrator-guard backup restore backup-list backup-verify nginx-setup build rebuild fix-permissions test lint

# ============================================================
# Docker Services
# ============================================================

up:
	docker compose up -d

down:
	docker compose down

restart:
	docker compose restart

build:
	docker compose up -d --build

rebuild:
	docker compose build --no-cache
	docker compose up -d
	docker image prune -f

logs:
	docker compose logs -f --tail 100

status:
	@echo "=== Textstack Status ==="
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(textstack|NAMES)"
	@echo ""
	@curl -sf http://localhost:8080/health > /dev/null && echo "API: healthy" || echo "API: unhealthy"

# ============================================================
# Database schema: textstack_v2 (database/README.md, ADR-026, ADR-030)
# ============================================================

# This checkout's database/ is mounted over the image's copy, so a migration just written runs
# without rebuilding the image.
MIGRATOR = docker compose run --rm -v "$(CURDIR)/database:/database:ro" migrator

# On the server the running Api carries its release (SENTRY_RELEASE, from GIT_SHA; empty in local
# builds). A checkout that is not that release — a deploy that failed after "Pull latest code" —
# must not run its own migrations under the old code: refuse, and name the image-only command.
migrator-guard:
	@rel=$$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $$(docker compose ps -q api) 2>/dev/null | sed -n 's/^SENTRY_RELEASE=//p'); \
	head=$$(git rev-parse --short=12 HEAD); \
	[ -z "$$rel" ] || [ "$$rel" = "$$head" ] || { \
		echo "This checkout ($$head) is not the running release ($$rel)."; \
		echo "Use the deployed image's files: docker compose run --rm migrator <up|down N|status>"; exit 1; }

migrate: migrator-guard
	$(MIGRATOR) up

# Reverts every applied version above V. Schema first, then the code (ADR-026).
migrate-down: migrator-guard
	@test -n "$(V)" || { echo 'usage: make migrate-down V=<version>'; exit 1; }
	$(MIGRATOR) down $(V)

migrate-status: migrator-guard
	$(MIGRATOR) status

# The baseline's rollback: 0000 has no down file, so `migrate-down V=0` undoes nothing. Drops the
# whole V2 database and its data; `make migrate` builds it again. CONFIRM must name the database.
migrate-drop: migrator-guard
	@test -n "$(CONFIRM)" || { echo 'usage: make migrate-drop CONFIRM=<TEXTSTACK_DB, default textstack_v2> (all its data is lost)'; exit 1; }
	$(MIGRATOR) drop $(CONFIRM)

# ============================================================
# Deployment
# ============================================================

# Fix volume permissions for containers running as non-root.
# Add a new cache dir here whenever a service starts writing to one — otherwise
# the host dir stays root-owned and the container (uid 1000) gets EACCES.
fix-permissions:
	@echo "Fixing volume permissions..."
	@docker run --rm -v $$(pwd)/data:/data alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 sh -c '\
		mkdir -p /data/library /data/tts-cache /data/explain-cache /data/translate-cache && \
		chown 1000:1000 /data/library && \
		chown -R 1000:1000 /data/tts-cache /data/explain-cache /data/translate-cache'
	@echo "Done."

# ============================================================
# Testing & Linting
# ============================================================

test:
	dotnet test
	pnpm -C apps/web test

lint:
	dotnet format --verify-no-changes

# ============================================================
# Nginx Setup (one-time)
# ============================================================

# Linux (systemd)
nginx-setup:
	@echo "Generating nginx config..."
	@PROJECT_DIR=$$(pwd) && \
	sudo sed "s|/home/vasyl/projects/onlinelib/textstack|$$PROJECT_DIR|g" \
		infra/nginx/textstack.conf > /tmp/textstack.conf && \
	sudo mv /tmp/textstack.conf /etc/nginx/sites-available/textstack && \
	sudo ln -sf /etc/nginx/sites-available/textstack /etc/nginx/sites-enabled/ && \
	sudo nginx -t && sudo systemctl reload nginx
	@echo "Done."

# Mac (homebrew)
nginx-setup-mac:
	@echo "Generating nginx config for Mac..."
	@sed "s|/home/vasyl/projects/onlinelib/textstack|$$(pwd)|g" \
		infra/nginx/textstack.conf > /opt/homebrew/etc/nginx/servers/textstack.conf
	@echo "Done. Run: sudo nginx -s reload"

# ============================================================
# Database Backup/Restore
# ============================================================

BACKUP_DIR := $(HOME)/backups/textstack
# Overridable only so the targets can be run against a throwaway Postgres.
DB_CONTAINER ?= textstack_db_prod
# The database's name, in a recipe that sourced .env.
DB_NAME_SH = $${TEXTSTACK_DB:-textstack_v2}
# Prints the database's name (ADR-030) when it exists in DB_CONTAINER, nothing when it does not.
DB_EXISTS = docker exec $(DB_CONTAINER) psql -XtA -U $$POSTGRES_USER -d postgres \
	-c "SELECT datname FROM pg_database WHERE datname = '$(DB_NAME_SH)'"

# The V2 database only (ADR-030): it holds all live data since the cutover; the legacy one is
# read-only and archived. The same checked dump as backup.yml: a missing database or a dump without
# pg_dump's trailer exits 1, and no half-written .gz is left behind.
backup:
	@mkdir -p $(BACKUP_DIR)
	@. ./.env && db=$(DB_NAME_SH) && POSTGRES_USER=$$POSTGRES_USER DB_CONTAINER=$(DB_CONTAINER) \
		bash infra/scripts/pg-dump-checked.sh $$db $(BACKUP_DIR)/$$db-db_$$(date +%Y-%m-%d_%H%M%S).sql.gz

# A V2 dump (textstack_v2-db_*.sql.gz, textstack_v2-db-*, textstack_v2-pre-deploy-*) into a V2
# database that does not exist: a dump loaded over tables already there would half-apply. Drop it
# first (migrate-drop). Created by run.sh, as the migrator creates it: ICU, from template0.
# bash: the load needs pipefail, which /bin/sh (dash) may not have.
restore: SHELL := /bin/bash
restore:
	@test -n "$(FILE)" || { echo "Usage: make restore FILE=$(BACKUP_DIR)/textstack_v2-db_YYYY-MM-DD_HHMMSS.sql.gz"; exit 1; }
	@# Before anything is created: a typo must not leave an empty V2 that then blocks the retry.
	@test -f "$(FILE)" || { echo "No such file: $(FILE)"; exit 1; }
	@. ./.env && db=$$($(DB_EXISTS)) || exit 1; \
	[ -z "$$db" ] || { echo "$$db exists. Restore only into an absent one: make migrate-drop CONFIRM=$$db first."; exit 1; }
	$(MIGRATOR) create
	@set -o pipefail; . ./.env && gunzip -c $(FILE) | docker exec -i $(DB_CONTAINER) psql -X -q -v ON_ERROR_STOP=1 -U $$POSTGRES_USER -d $(DB_NAME_SH)
	@echo "Done."

backup-list:
	@ls -lh $(BACKUP_DIR)/*.sql.gz 2>/dev/null || echo "No backups found"

backup-verify:
	@FILE="$(FILE)"; \
	if [ -z "$$FILE" ]; then \
		FILE=$$(. ./.env && ls -1t $(BACKUP_DIR)/$(DB_NAME_SH)-db*.sql.gz 2>/dev/null | head -n 1); \
	fi; \
	if [ -z "$$FILE" ]; then \
		echo "No backup found. Pass FILE=... or run 'make backup' first."; \
		exit 1; \
	fi; \
	echo "Verifying $$FILE ..."; \
	./infra/scripts/backup-verify.sh "$$FILE"
