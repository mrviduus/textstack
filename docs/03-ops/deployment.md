# Production Deployment

## Architecture Overview

```
Internet
    │
    ▼
Cloudflare (DNS + SSL + DDoS protection)
    │
    ▼
Cloudflare Tunnel (cloudflared daemon)
    │
    ▼
Host nginx (port 80)
    ├── textstack.app     → SSG/SPA static files + /api/ → :8080 + /mcp → :8090
    └── textstack.dev     → admin panel :81 (auth-gated)
    │
    ▼
Docker containers (localhost only)
    ├── API           (127.0.0.1:8080)
    ├── Worker        (background jobs)
    ├── SSG Worker    (pre-renders SEO pages)
    ├── Admin         (127.0.0.1:81)
    ├── Migrator      (runs once, then exits)
    ├── PostgreSQL    (pgvector/pgvector:pg16 image, internal only)
    ├── Ollama        (vocab distractors/hints, internal only)
    ├── MCP server    (127.0.0.1:8090, `--profile mcp`)
    └── Aspire Dashboard (127.0.0.1:18888, `--profile observability` opt-in)
```

## Prerequisites

- Ubuntu 22.04+ server
- Docker & Docker Compose
- Node.js 20+ with pnpm
- Domain(s) registered with DNS provider
- Cloudflare account (free tier)

## Security Model

| Component | Exposure | Protection |
|-----------|----------|------------|
| Web frontend | Public | Cloudflare WAF, rate limiting |
| API | Public via /api/ path | Rate limiting, JWT auth |
| Admin panel | Public at textstack.dev via the tunnel; container bound to 127.0.0.1:81 | Admin JWT auth, not indexed |
| PostgreSQL | Docker internal | No external ports |
| Aspire Dashboard | localhost only | Not exposed |
| SSH | Port 22 | UFW firewall, key auth |

## Initial Setup

### 1. System Preparation

```bash
sudo apt-get update
sudo apt-get install -y nginx ufw docker.io docker-compose-plugin

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Firewall Configuration

```bash
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 80/tcp comment 'HTTP (Cloudflare tunnel)'
sudo ufw --force enable
sudo ufw status
```

**Note:** Port 443 not needed - Cloudflare handles SSL termination.

### 3. Cloudflare Setup

1. Add domain(s) to Cloudflare
2. Update nameservers at registrar
3. Create Cloudflare Tunnel:
   - Zero Trust → Networks → Tunnels → Create
   - Install cloudflared: `sudo cloudflared service install <TOKEN>`
   - Add routes: `domain.com` → `http://localhost:80`

### 4. Nginx Configuration

```bash
# Remove default site
sudo rm -f /etc/nginx/sites-enabled/default

# Install config (auto-replaces paths)
make nginx-setup

# Or manually:
sudo cp infra/nginx/textstack.conf /etc/nginx/sites-available/textstack
sudo ln -sf /etc/nginx/sites-available/textstack /etc/nginx/sites-enabled/textstack

# Set permissions
chmod 755 /home/$USER
chmod -R 755 /home/$USER/projects/onlinelib/textstack/apps/web/dist

# Test and restart
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx
```

### 5. Environment Configuration

Create `.env` from example (never commit secrets to git):

```bash
cp .env.example .env

# Generate secure values
openssl rand -base64 24  # for POSTGRES_PASSWORD
openssl rand -base64 32  # for JWT_SECRET

# Edit .env with generated values
nano .env
```

Example `.env`:
```env
POSTGRES_USER=textstack_prod
POSTGRES_PASSWORD=<generated>
POSTGRES_DB=textstack_prod

ASPNETCORE_ENVIRONMENT=Production

JWT_SECRET=<generated_32+_chars>
JWT_ISSUER=textstack.app
JWT_AUDIENCE=textstack.app

GOOGLE_CLIENT_ID=<your-google-client-id>
```

### 6. Build Frontend

```bash
cd apps/web
pnpm install
VITE_API_URL=/api VITE_CANONICAL_URL=https://textstack.app pnpm build
cd ../..
```

### 7. Start Services

```bash
docker compose up -d --build
```

Or use Makefile:
```bash
make up
```

## Verification Checklist

```bash
# Services running
docker ps
make status
sudo systemctl status nginx
sudo systemctl status cloudflared

# Health checks
curl http://localhost:8080/health
curl http://localhost:80

# From phone (mobile data, not WiFi)
# https://textstack.app
# https://textstack.dev
```

## Operations

### Daily Commands

```bash
make up           # Start all services
make down         # Stop all services
make restart      # Restart all services
make logs         # View logs (tail -f)
make status       # Show service status
```

### Deployment

**Normal path: merge to `main`.** `.github/workflows/deploy.yml` runs on a self-hosted runner on
the server: re-runs `backend` + `frontend` CI on the merged tree → pre-deploy backup → pull →
build web (preserving the current `dist/ssg` across vite's wipe) → `docker compose up` → sync
nginx config → health checks (API, frontend, MCP) → queue SSG rebuild and wait → validate SSG →
restart systemd pollers → prune images. Do not deploy by hand over SSH.

Re-deploy or roll back without a merge: run the same workflow by hand.
```bash
gh workflow run deploy.yml                                  # redeploy main
gh workflow run deploy.yml -f rollback_commit=<sha>         # roll back
```
(`make deploy` was deleted 2026-10: it had drifted from the workflow — no GPU overlay, no MCP profile.)

Break-glass only:

Or manually:
```bash
git pull origin main
cd apps/web && pnpm install && VITE_API_URL=/api VITE_STORAGE_URL=https://textstack.app VITE_CANONICAL_URL=https://textstack.app VITE_GOOGLE_CLIENT_ID=<id> pnpm build
docker compose up -d --build
```

### SSG Rebuild

SSG pages are pre-rendered for SEO. Rebuild after content changes:

```bash
# Via Makefile (runs on host)
make rebuild-ssg

# Via Admin Panel (recommended)
# Go to https://textstack.dev → SSG Rebuild → New Rebuild
```

The `ssg-worker` container automatically picks up rebuild jobs created via admin panel.

### Database Access

```bash
# Connect to DB
docker exec -it textstack_db_prod psql -U $POSTGRES_USER -d $POSTGRES_DB

# Or with make (reads .env)
. ./.env && docker exec -it textstack_db_prod psql -U $POSTGRES_USER -d $POSTGRES_DB
```

## Backup & Restore

### Backup

```bash
make backup           # Creates timestamped backup in ~/backups/textstack/
make backup-list      # List existing backups
```

### Restore

```bash
make restore FILE=~/backups/textstack/db_2026-01-23_120000.sql.gz
```

### Automated Backups

GitHub Actions runs daily backup at 3 AM UTC (see `.github/workflows/backup.yml`).

## Monitoring

### Aspire Dashboard

Access: `http://localhost:18888` (via SSH tunnel)

Shows:
- Distributed traces
- Logs from all services
- Metrics

### Health Endpoints

| Endpoint | Expected |
|----------|----------|
| `http://localhost:8080/health` | 200 OK |
| `https://textstack.app/api/health` | 200 OK |

### Logs

```bash
# All services
make logs

# Specific service
docker logs textstack_api_prod -f
docker logs textstack_worker_prod -f
docker logs textstack_ssg_worker -f
docker logs textstack_admin_prod -f

# Nginx
sudo tail -f /var/log/nginx/error.log

# Cloudflared
sudo journalctl -u cloudflared -f
```

### Resource Usage

```bash
docker stats --no-stream
df -h
free -h
```

## Troubleshooting

| Issue | Check | Fix |
|-------|-------|-----|
| Site not loading | `sudo systemctl status cloudflared` | Restart cloudflared |
| 502 Bad Gateway | `docker ps` | Restart API container |
| API errors | `docker logs textstack_api_prod` | Check logs for details |
| DNS not resolving | `dig textstack.app` | Wait for propagation / check Cloudflare |
| Permission denied | nginx logs | `chmod 755` on directories |
| SSG not updating | Check ssg-worker logs | Trigger rebuild via admin |

## Security Checklist

- [ ] `.env` not in git (check: `git status`)
- [ ] Strong passwords (24+ chars, generated)
- [ ] JWT secret 32+ chars
- [ ] UFW enabled with minimal ports
- [ ] SSH key authentication (disable password)
- [ ] Regular backups configured
- [ ] Cloudflare SSL mode: Full (strict)

## Rollback Procedure

Preferred: run the **Deploy** workflow manually (`workflow_dispatch`) with `rollback_commit=<sha>`.

Manual fallback:
```bash
# 1. Stop current version
docker compose down

# 2. Restore previous code
git checkout <previous-commit>

# 3. Rebuild frontend
cd apps/web && pnpm build && cd ../..

# 4. Restore database (if needed)
make restore FILE=/path/to/backup.sql.gz

# 5. Start services
docker compose up -d --build
```

## File Locations

| Item | Path |
|------|------|
| Project root | `/home/vasyl/projects/onlinelib/textstack` |
| Docker Compose | `docker-compose.yml` |
| Environment file | `.env` (not in git) |
| Nginx config | `/etc/nginx/sites-available/textstack` |
| Nginx config source | `infra/nginx/textstack.conf` |
| Frontend dist | `apps/web/dist/` |
| SSG pages | `apps/web/dist/ssg/` |
| Storage data | `data/storage/` |
| Database data | `data/postgres-prod/` |
| Backups | `~/backups/textstack/` (`make backup`); nightly job: see `.github/workflows/backup.yml` |

## See Also

- [Environment Variables](environment-variables.md)
- [CI/CD Pipeline](../../.github/workflows/)
- [SSG Documentation](../02-system/ssg-prerender.md)
