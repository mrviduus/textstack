.PHONY: up down restart logs status backup restore rebuild-ssg clean-ssg deploy nginx-setup

# ============================================================
# Docker Services
# ============================================================

up:
	docker compose up -d

down:
	docker compose down

restart:
	docker compose restart

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

deploy:
	@echo "=== Deploy ==="
	git pull origin main
	cd apps/web && pnpm install && VITE_API_URL=/api VITE_CANONICAL_URL=https://textstack.app pnpm build
	docker compose up -d --build
	@sleep 10
	@curl -sf http://localhost:8080/health && echo " API OK" || echo " API FAILED"
	cd apps/web && \
	API_URL=http://localhost:8080 API_HOST=textstack.app CONCURRENCY=4 \
	node scripts/prerender.mjs --output-dir dist/ssg-new && \
	rm -rf dist/ssg-old && \
	([ -d dist/ssg ] && mv dist/ssg dist/ssg-old || true) && \
	mv dist/ssg-new dist/ssg && \
	rm -rf dist/ssg-old
	@echo "Updating nginx config..."
	@PROJECT_DIR=$$(pwd) && \
	sed "s|/home/vasyl/projects/onlinelib/onlinelib|$$PROJECT_DIR|g" \
		infra/nginx/textstack.conf | sudo tee /etc/nginx/sites-available/textstack > /dev/null
	sudo nginx -t && sudo systemctl reload nginx
	@echo "=== Done ==="

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

# ============================================================
# Nginx Setup (one-time)
# ============================================================

# Linux (systemd)
nginx-setup:
	@echo "Generating nginx config..."
	@PROJECT_DIR=$$(pwd) && \
	sudo sed "s|/home/vasyl/projects/onlinelib/onlinelib|$$PROJECT_DIR|g" \
		infra/nginx/textstack.conf > /tmp/textstack.conf && \
	sudo mv /tmp/textstack.conf /etc/nginx/sites-available/textstack && \
	sudo ln -sf /etc/nginx/sites-available/textstack /etc/nginx/sites-enabled/ && \
	sudo nginx -t && sudo systemctl reload nginx
	@echo "Done."

# Mac (homebrew)
nginx-setup-mac:
	@echo "Generating nginx config for Mac..."
	@sed "s|/home/vasyl/projects/onlinelib/onlinelib|$$(pwd)|g" \
		infra/nginx/textstack.conf > /opt/homebrew/etc/nginx/servers/textstack.conf
	@echo "Done. Run: sudo nginx -s reload"

# ============================================================
# Database Backup/Restore
# ============================================================

backup:
	@mkdir -p backups
	@. ./.env && docker exec textstack_db_prod pg_dump -U $$POSTGRES_USER $$POSTGRES_DB | gzip > backups/db_$$(date +%Y-%m-%d_%H%M%S).sql.gz
	@echo "Backup saved:"
	@ls -lh backups/db_*.sql.gz | tail -1

restore:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make restore FILE=backups/db_YYYY-MM-DD_HHMMSS.sql.gz"; \
		exit 1; \
	fi
	@echo "Restoring from $(FILE)..."
	@. ./.env && gunzip -c $(FILE) | docker exec -i textstack_db_prod psql -U $$POSTGRES_USER $$POSTGRES_DB
	@echo "Done."

backup-list:
	@ls -lh backups/*.sql.gz 2>/dev/null || echo "No backups found"
