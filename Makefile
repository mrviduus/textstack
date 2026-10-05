.PHONY: up down restart logs status backup restore backup-list backup-verify rebuild-ssg clean-ssg featured featured-show nginx-setup build rebuild fix-permissions test lint seo-publish-setup seo-publish-status seo-publish-logs seo-publish-restart seo-publish-stop quality-poll-setup quality-poll-status quality-poll-logs quality-poll-restart quality-poll-stop

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
# Deployment
# ============================================================

# Fix volume permissions for containers running as non-root.
# Add a new cache dir here whenever a service starts writing to one — otherwise
# the host dir stays root-owned and the container (uid 1000) gets EACCES.
fix-permissions:
	@echo "Fixing volume permissions..."
	@docker run --rm -v $$(pwd)/data:/data alpine sh -c '\
		mkdir -p /data/textstack /data/tts-cache /data/explain-cache /data/translate-cache /data/pdf-cleanup-dataset && \
		chown -R 1000:1000 /data/textstack /data/tts-cache /data/explain-cache /data/translate-cache /data/pdf-cleanup-dataset'
	@echo "Done."

rebuild-ssg:
	@echo "=== SSG Rebuild (atomic swap) ==="
	cd apps/web && \
	API_URL=http://localhost:8080 API_HOST=textstack.app CONCURRENCY=4 \
	node scripts/prerender.mjs --output-dir dist/ssg-new && \
	rm -rf dist/ssg-old && \
	([ -d dist/ssg ] && mv dist/ssg dist/ssg-old || true) && \
	mv dist/ssg-new dist/ssg && \
	rm -rf dist/ssg-old
	@echo "=== Done ==="

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

backup:
	@mkdir -p $(BACKUP_DIR)
	@. ./.env && docker exec textstack_db_prod pg_dump -U $$POSTGRES_USER $$POSTGRES_DB | gzip > $(BACKUP_DIR)/db_$$(date +%Y-%m-%d_%H%M%S).sql.gz
	@echo "Backup saved:"
	@ls -lh $(BACKUP_DIR)/db_*.sql.gz | tail -1

restore:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make restore FILE=$(BACKUP_DIR)/db_YYYY-MM-DD_HHMMSS.sql.gz"; \
		exit 1; \
	fi
	@echo "Restoring from $(FILE)..."
	@. ./.env && gunzip -c $(FILE) | docker exec -i textstack_db_prod psql -U $$POSTGRES_USER $$POSTGRES_DB
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
