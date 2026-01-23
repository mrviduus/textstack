.PHONY: backup restore backup-list deploy deploy-quick prod-status prod-logs prod-restart

# ============================================================
# Production Deployment
# ============================================================

# Full deploy: pull code, build frontend + SSG, restart containers
deploy:
	@echo "=== Production Deploy ==="
	@echo "1. Pulling latest code..."
	git pull origin main
	@echo ""
	@echo "2. Building frontend..."
	cd apps/web && pnpm install && VITE_API_URL=/api VITE_CANONICAL_URL=https://textstack.app pnpm build
	@echo ""
	@echo "3. Restarting containers..."
	docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
	@echo ""
	@echo "4. Waiting for API..."
	sleep 10
	@curl -sf http://localhost:8080/health && echo " API OK" || echo " API FAILED"
	@echo ""
	@echo "5. Building SSG pages..."
	cd apps/web && API_URL=http://localhost:8080 API_HOST=textstack.app CONCURRENCY=4 node scripts/prerender.mjs
	@echo ""
	@echo "6. Reloading nginx..."
	sudo systemctl reload nginx
	@echo ""
	@echo "7. Final health check..."
	@curl -sf http://localhost:80 > /dev/null && echo " Nginx OK" || echo " Nginx FAILED"
	@echo ""
	@echo "=== Deploy Complete ==="

# Quick deploy: just restart containers (no rebuild)
deploy-quick:
	@echo "=== Quick Restart ==="
	docker compose -f docker-compose.prod.yml --env-file .env.production restart
	@sleep 5
	@curl -sf http://localhost:8080/health && echo "API OK" || echo "API FAILED"

# Show production status
prod-status:
	@echo "=== Production Status ==="
	@echo ""
	@echo "Docker containers:"
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(textstack|NAMES)"
	@echo ""
	@echo "Services:"
	@systemctl is-active nginx > /dev/null && echo "nginx: running" || echo "nginx: stopped"
	@systemctl is-active cloudflared > /dev/null && echo "cloudflared: running" || echo "cloudflared: stopped"
	@echo ""
	@echo "Health:"
	@curl -sf http://localhost:8080/health > /dev/null && echo "API: healthy" || echo "API: unhealthy"
	@curl -sf http://localhost:80 > /dev/null && echo "Web: accessible" || echo "Web: inaccessible"

# View production logs
prod-logs:
	@echo "=== API Logs (last 50 lines) ==="
	docker logs textstack_api_prod --tail 50

# Restart all production services
prod-restart:
	@echo "Restarting production services..."
	docker compose -f docker-compose.prod.yml --env-file .env.production restart
	sudo systemctl restart nginx
	@echo "Done"

# Rebuild SSG only (no container restart, requires API running)
rebuild-ssg:
	@echo "Rebuilding SSG pages..."
	cd apps/web && API_URL=http://localhost:8080 API_HOST=textstack.app CONCURRENCY=4 node scripts/prerender.mjs
	@echo "Done. Files in apps/web/dist/ssg/"

# ============================================================
# PostgreSQL Backup/Restore
# ============================================================

backup:
	@./scripts/backup_postgres.sh

# Production backup
backup-prod:
	@echo "Backing up production database..."
	@mkdir -p backups
	@docker exec textstack_db_prod pg_dump -U textstack_prod textstack_prod | gzip > backups/prod_$$(date +%Y-%m-%d_%H%M%S).sql.gz
	@echo "Backup saved to backups/"
	@ls -lh backups/prod_*.sql.gz | tail -1

restore:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make restore FILE=backups/db_YYYY-MM-DD_HHMMSS.sql.gz"; \
		exit 1; \
	fi
	@echo "Restoring from $(FILE)..."
	@gunzip -c $(FILE) | docker exec -i books_db psql -U app books
	@echo "Restore completed"

# Restore to production
restore-prod:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make restore-prod FILE=backups/prod_YYYY-MM-DD_HHMMSS.sql.gz"; \
		exit 1; \
	fi
	@echo "WARNING: Restoring to PRODUCTION database!"
	@echo "Press Ctrl+C to cancel, Enter to continue..."
	@read dummy
	@echo "Restoring from $(FILE)..."
	@gunzip -c $(FILE) | docker exec -i textstack_db_prod psql -U textstack_prod textstack_prod
	@echo "Restore completed"

backup-list:
	@echo "Available backups:"
	@ls -lh backups/*.sql.gz 2>/dev/null || echo "  No backups found"
