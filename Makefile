.PHONY: up down restart logs status migrate migrate-down migrate-status migrate-v2 migrate-v2-down migrate-v2-status migrate-v2-drop etl-v2 migrator-guard backup restore restore-v2 backup-list backup-verify rebuild-ssg clean-ssg featured featured-show nginx-setup build rebuild fix-permissions test lint seo-publish-setup seo-publish-status seo-publish-logs seo-publish-restart seo-publish-stop quality-poll-setup quality-poll-status quality-poll-logs quality-poll-restart quality-poll-stop

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
# Database schema (database/README.md, ADR-026)
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
		echo "Use the deployed image's files: docker compose run --rm migrator (or migrator-v2) <up|down N|status>"; exit 1; }

migrate: migrator-guard
	$(MIGRATOR) up

# Reverts every applied version above V. Schema first, then the code (ADR-026).
migrate-down: migrator-guard
	@test -n "$(V)" || { echo 'usage: make migrate-down V=<version>'; exit 1; }
	$(MIGRATOR) down $(V)

migrate-status: migrator-guard
	$(MIGRATOR) status

# The same for textstack_v2 (database/v2/, ADR-030).
MIGRATOR_V2 = docker compose run --rm -v "$(CURDIR)/database:/database:ro" migrator-v2

migrate-v2: migrator-guard
	$(MIGRATOR_V2) up

migrate-v2-down: migrator-guard
	@test -n "$(V)" || { echo 'usage: make migrate-v2-down V=<version>'; exit 1; }
	$(MIGRATOR_V2) down $(V)

migrate-v2-status: migrator-guard
	$(MIGRATOR_V2) status

# The baseline's rollback: 0000 has no down file, so `migrate-v2-down V=0` undoes nothing. Drops the
# whole V2 database and its data; `make migrate-v2` builds it again. CONFIRM must name the database.
migrate-v2-drop: migrator-guard
	@test -n "$(CONFIRM)" || { echo 'usage: make migrate-v2-drop CONFIRM=<V2_POSTGRES_DB, default textstack_v2> (all its data is lost)'; exit 1; }
	$(MIGRATOR_V2) drop $(CONFIRM)

# The ETL legacy -> textstack_v2 (v2-plan §5.2), in a one-off container of the api image (its own
# process, signals proxied; no deploy may recreate it mid-run). Not the schema: that is migrate-v2. Runbook: docs/03-ops/v2-etl.md. ARGS=--dry-run reports without writing anything.
# Connection strings come from the env, never ARGS (argv is visible in ps; etl-v2 refuses a password
# there): ConnectionStrings__Default=... ConnectionStrings__V2=... make etl-v2. Each one set is passed
# by NAME (-e NAME, value read from this env), so it is on no command line; unset, the compose file's
# value stays (a bare -e NAME would blank it). @: the recipe is not echoed.
etl-v2:
	@docker compose run --rm --no-deps -T $(if $(ConnectionStrings__Default),-e ConnectionStrings__Default) $(if $(ConnectionStrings__V2),-e ConnectionStrings__V2) api etl-v2 $(ARGS)

# ============================================================
# Deployment
# ============================================================

# Fix volume permissions for containers running as non-root.
# Add a new cache dir here whenever a service starts writing to one — otherwise
# the host dir stays root-owned and the container (uid 1000) gets EACCES.
fix-permissions:
	@echo "Fixing volume permissions..."
	@docker run --rm -v $$(pwd)/data:/data alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 sh -c '\
		mkdir -p /data/library /data/textstack /data/tts-cache /data/explain-cache /data/translate-cache /data/pdf-cleanup-dataset && \
		chown 1000:1000 /data/library && \
		chown -R 1000:1000 /data/textstack /data/tts-cache /data/explain-cache /data/translate-cache /data/pdf-cleanup-dataset'
	@echo "Done."

# Queues a Full rebuild for ssg-worker and follows it to the end (the only rebuild besides admin, #992).
rebuild-ssg:
	@./infra/scripts/rebuild-ssg.sh

clean-ssg:
	rm -rf apps/web/dist/ssg apps/web/dist/ssg-new apps/web/dist/ssg-old
	@echo "SSG cleaned"

# Popular shelf. Run ON the server (api is bound to 127.0.0.1:8080). Replaces the whole
# shelf in the given order and queues a Full SSG rebuild. Node builds the JSON (quoting).
featured:
	@test -n "$(SLUGS)" || { echo 'usage: make featured SLUGS="nineteen-eighty-four animal-farm ..."'; exit 1; }
	@node -e 'console.log(JSON.stringify({slugs: process.argv.slice(1)}))' $(SLUGS) | \
	curl -sS --fail-with-body -X PUT http://127.0.0.1:8080/internal/featured \
		-H 'Host: textstack.app' -H 'Content-Type: application/json' --data-binary @-; echo

featured-show:
	@curl -sS --fail-with-body -H 'Host: textstack.app' 'http://127.0.0.1:8080/en/books?sort=popular&limit=100' | \
	node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { for (const b of JSON.parse(s).items) if (b.featuredRank != null) console.log(b.featuredRank, b.slug) })'

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
# Prints the V2 database's name (ADR-030) when it exists in DB_CONTAINER, nothing when it does not.
V2_EXISTS = docker exec $(DB_CONTAINER) psql -XtA -U $$POSTGRES_USER -d postgres \
	-c "SELECT datname FROM pg_database WHERE datname = '$${V2_POSTGRES_DB:-textstack_v2}'"

backup:
	@mkdir -p $(BACKUP_DIR)
	@# The same checked dump as backup.yml: pipefail + trailer, so a failed pg_dump never leaves an
	@# empty .gz behind a "Backup saved" line.
	@. ./.env && POSTGRES_USER=$$POSTGRES_USER DB_CONTAINER=$(DB_CONTAINER) \
		bash infra/scripts/pg-dump-checked.sh $$POSTGRES_DB $(BACKUP_DIR)/db_$$(date +%Y-%m-%d_%H%M%S).sql.gz
	@ls -lh $(BACKUP_DIR)/db_*.sql.gz | tail -1
	@# V2 after legacy, so nothing legacy waits on it; a database migrator-v2 has not created yet
	@# (profile `v2`) is skipped, not an error.
	@. ./.env && v2=$${V2_POSTGRES_DB:-textstack_v2} && POSTGRES_USER=$$POSTGRES_USER DB_CONTAINER=$(DB_CONTAINER) \
		bash infra/scripts/pg-dump-checked.sh $$v2 $(BACKUP_DIR)/$$v2-db_$$(date +%Y-%m-%d_%H%M%S).sql.gz

restore:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make restore FILE=$(BACKUP_DIR)/db_YYYY-MM-DD_HHMMSS.sql.gz"; \
		exit 1; \
	fi
	@# A V2 dump is often the newest file in backup-list; loaded here it would put V2 tables into legacy.
	@. ./.env && case "$(notdir $(FILE))" in $${V2_POSTGRES_DB:-textstack_v2}-*) \
		echo "$(FILE) is a V2 dump: make restore-v2 FILE=$(FILE)"; exit 1;; esac
	@echo "Restoring from $(FILE)..."
	@. ./.env && gunzip -c $(FILE) | docker exec -i $(DB_CONTAINER) psql -v ON_ERROR_STOP=1 -U $$POSTGRES_USER $$POSTGRES_DB
	@echo "Done."

# A V2 dump (textstack_v2-db_*.sql.gz, textstack_v2-db-*, textstack_v2-pre-deploy-*) into a V2
# database that does not exist: a dump loaded over tables already there would half-apply. Drop it
# first (migrate-v2-drop). Created by run.sh, as migrator-v2 creates it: ICU, from template0.
# bash: the load needs pipefail, which /bin/sh (dash) may not have.
restore-v2: SHELL := /bin/bash
restore-v2:
	@test -n "$(FILE)" || { echo "Usage: make restore-v2 FILE=$(BACKUP_DIR)/textstack_v2-db_YYYY-MM-DD_HHMMSS.sql.gz"; exit 1; }
	@# Before anything is created: a typo must not leave an empty V2 that then blocks the retry.
	@test -f "$(FILE)" || { echo "No such file: $(FILE)"; exit 1; }
	@. ./.env && v2=$$($(V2_EXISTS)) || exit 1; \
	[ -z "$$v2" ] || { echo "$$v2 exists. Restore only into an absent one: make migrate-v2-drop CONFIRM=$$v2 first."; exit 1; }
	$(MIGRATOR_V2) create
	@set -o pipefail; . ./.env && gunzip -c $(FILE) | docker exec -i $(DB_CONTAINER) psql -X -q -v ON_ERROR_STOP=1 -U $$POSTGRES_USER -d $${V2_POSTGRES_DB:-textstack_v2}
	@echo "Done."

backup-list:
	@ls -lh $(BACKUP_DIR)/*.sql.gz 2>/dev/null || echo "No backups found"

backup-verify:
	@FILE="$(FILE)"; \
	if [ -z "$$FILE" ]; then \
		FILE=$$(ls -1t $(BACKUP_DIR)/db*.sql.gz 2>/dev/null | head -n 1); \
	fi; \
	if [ -z "$$FILE" ]; then \
		echo "No backup found. Pass FILE=... or run 'make backup' first."; \
		exit 1; \
	fi; \
	echo "Verifying $$FILE ..."; \
	./infra/scripts/backup-verify.sh "$$FILE"

# ============================================================
# SEO Auto-Publish
# ============================================================

seo-publish-setup:
	@mkdir -p ~/.config/systemd/user
	@cp infra/systemd/seo-publish-poller.service ~/.config/systemd/user/
	@systemctl --user daemon-reload
	@systemctl --user enable seo-publish-poller
	@systemctl --user start seo-publish-poller
	@loginctl enable-linger $$(whoami)
	@echo "SEO Auto-Publish poller installed and started."

seo-publish-status:
	@systemctl --user status seo-publish-poller

seo-publish-logs:
	@journalctl --user -u seo-publish-poller -f

seo-publish-restart:
	@systemctl --user restart seo-publish-poller

seo-publish-stop:
	@systemctl --user stop seo-publish-poller

# ============================================================
# Book Quality Poller (Phase 1-2 structure fixes + Phase 3 content cleanup)
# ============================================================

quality-poll-setup:
	@mkdir -p ~/.config/systemd/user
	@cp infra/systemd/quality-poller.service ~/.config/systemd/user/
	@systemctl --user daemon-reload
	@systemctl --user enable quality-poller
	@systemctl --user start quality-poller
	@loginctl enable-linger $$(whoami)
	@echo "Book Quality poller installed and started."

quality-poll-status:
	@systemctl --user status quality-poller

quality-poll-logs:
	@journalctl --user -u quality-poller -f

quality-poll-restart:
	@systemctl --user restart quality-poller

quality-poll-stop:
	@systemctl --user stop quality-poller

# ============================================================
# SEO Backfill (template-driven SEO generation for Authors/Editions/Genres/Blog)
# ============================================================

seo-backfill-setup:
	@mkdir -p ~/.config/systemd/user
	@cp infra/systemd/seo-backfill-poller.service ~/.config/systemd/user/
	@systemctl --user daemon-reload
	@systemctl --user enable seo-backfill-poller
	@systemctl --user start seo-backfill-poller
	@loginctl enable-linger $$(whoami)
	@echo "SEO Backfill poller installed and started."

seo-backfill-status:
	@systemctl --user status seo-backfill-poller

seo-backfill-logs:
	@journalctl --user -u seo-backfill-poller -f

seo-backfill-restart:
	@systemctl --user restart seo-backfill-poller

seo-backfill-stop:
	@systemctl --user stop seo-backfill-poller
