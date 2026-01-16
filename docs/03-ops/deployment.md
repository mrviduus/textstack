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
    ├── textstack.app     → static files + /api/ proxy (X-Site-Id: general)
    └── textstack.dev     → static files + /api/ proxy (X-Site-Id: programming)
    │
    ▼
Docker containers (localhost only)
    ├── API        (127.0.0.1:8080)
    ├── Worker     (background jobs)
    ├── Admin      (127.0.0.1:5174)
    ├── PostgreSQL (internal only)
    └── Observability Stack
        ├── Grafana     (127.0.0.1:3000)
        ├── Prometheus  (127.0.0.1:9090)
        ├── Loki        (internal)
        └── OTEL Collector (internal)
```

## Prerequisites

- Ubuntu 22.04+ server
- Docker & Docker Compose
- Node.js 22+ with pnpm
- Domain(s) registered with DNS provider
- Cloudflare account (free tier)

## Security Model

| Component | Exposure | Protection |
|-----------|----------|------------|
| Web frontend | Public | Cloudflare WAF, rate limiting |
| API | Public via /api/ path | Rate limiting, JWT auth |
| Admin panel | localhost only | Not exposed to internet |
| PostgreSQL | Docker internal | No external ports |
| Grafana | localhost only | Password auth, not exposed |
| Prometheus | localhost only | Not exposed to internet |
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

# Install config
sudo cp infra/nginx-prod/textstack.conf /etc/nginx/sites-available/textstack
sudo ln -sf /etc/nginx/sites-available/textstack /etc/nginx/sites-enabled/textstack

# Set permissions
chmod 755 /home/$USER
chmod -R 755 /home/$USER/projects/onlinelib/onlinelib/apps/web/dist

# Test and restart
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx
```

### 5. Environment Configuration

Create `.env.production` (never commit to git):

```bash
# Generate secure values
openssl rand -base64 24  # for POSTGRES_PASSWORD
openssl rand -base64 32  # for JWT_SECRET
```

```env
# .env.production
POSTGRES_USER=textstack_prod
POSTGRES_PASSWORD=<generated>
POSTGRES_DB=textstack_prod

ASPNETCORE_ENVIRONMENT=Production

JWT_SECRET=<generated_32+_chars>
JWT_ISSUER=textstack-api
JWT_AUDIENCE=textstack-client

VITE_API_URL=/api

# Observability
GRAFANA_ADMIN_PASSWORD=<generated>
GRAFANA_ROOT_URL=http://localhost:3000
```

### 6. Build Frontend

```bash
cd apps/web
pnpm install
VITE_API_URL=/api pnpm build
```

### 7. Create Data Directories

```bash
# Observability data directories (need correct permissions)
mkdir -p data/grafana-prod data/prometheus-prod data/loki-prod
sudo chmod 777 data/grafana-prod data/prometheus-prod data/loki-prod
```

### 8. Start Services

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

## Verification Checklist

```bash
# Services running
docker ps
sudo systemctl status nginx
sudo systemctl status cloudflared

# Health checks
curl http://localhost:8080/health
curl http://localhost:80

# Observability
curl http://localhost:3000/api/health  # Grafana
curl http://localhost:9090/-/healthy   # Prometheus

# From phone (mobile data, not WiFi)
# https://textstack.app
# https://textstack.dev
```

## Operations

### Service Management

```bash
# View logs
docker logs textstack_api_prod -f
docker logs textstack_worker_prod -f
sudo journalctl -u nginx -f
sudo journalctl -u cloudflared -f

# Restart services
docker compose -f docker-compose.prod.yml --env-file .env.production restart
sudo systemctl restart nginx
sudo systemctl restart cloudflared

# Stop all
docker compose -f docker-compose.prod.yml down
```

### Code Updates

```bash
cd /home/vasyl/projects/onlinelib/onlinelib
git pull

# Rebuild frontend
cd apps/web && pnpm build && cd ../..

# Rebuild and restart containers
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

### Database Access

```bash
# Connect to prod DB
docker exec -it textstack_db_prod psql -U textstack_prod -d textstack_prod

# Run migrations manually (if needed)
docker compose -f docker-compose.prod.yml --env-file .env.production up migrator
```

## Backup Strategy

See [backup.md](backup.md) for detailed procedures.

### Production Backup Script

```bash
#!/bin/bash
# /home/vasyl/scripts/backup-prod.sh

DATE=$(date +%F-%H%M)
BACKUP_DIR=/home/vasyl/backups
PROJECT_DIR=/home/vasyl/projects/onlinelib/onlinelib

mkdir -p $BACKUP_DIR

# Database
docker exec textstack_db_prod pg_dump -U textstack_prod textstack_prod | gzip > $BACKUP_DIR/db-$DATE.sql.gz

# Storage files
tar czf $BACKUP_DIR/storage-$DATE.tar.gz -C $PROJECT_DIR/data storage

# Cleanup (keep 7 days)
find $BACKUP_DIR -name "*.gz" -mtime +7 -delete

echo "Backup completed: $DATE"
```

### Crontab

```bash
# Daily at 3 AM
0 3 * * * /home/vasyl/scripts/backup-prod.sh >> /var/log/textstack-backup.log 2>&1
```

## Monitoring & Observability

### Grafana Dashboard

Access: `http://localhost:3000` (SSH tunnel or local access)

**Key dashboards:**
- **Ingestion Overview** - Book processing health, success rates
- **Extraction Performance** - Processing latencies by format
- **Worker Health** - Queue depth, throughput

See [Observability Guide](../../observability/README.md) for detailed usage.

### Health Endpoints

| Endpoint | Expected |
|----------|----------|
| `http://localhost:8080/health` | 200 OK |
| `https://textstack.app/api/health` | 200 OK |
| `http://localhost:3000/api/health` | 200 OK (Grafana) |
| `http://localhost:9090/-/healthy` | 200 OK (Prometheus) |

### Logs

**Centralized logs (Grafana → Explore → Loki):**
```logql
{service_name="onlinelib-api"}           # API logs
{service_name="onlinelib-worker"}        # Worker logs
{service_name="onlinelib-api"} | json | level="Error"  # Errors only
```

**Direct Docker logs:**

| Service | Command |
|---------|---------|
| API | `docker logs textstack_api_prod` |
| Worker | `docker logs textstack_worker_prod` |
| Nginx | `sudo tail -f /var/log/nginx/error.log` |
| Cloudflared | `sudo journalctl -u cloudflared` |
| Grafana | `docker logs textstack_grafana_prod` |
| OTEL Collector | `docker logs textstack_otel_prod` |

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
| No logs in Loki | `docker logs textstack_otel_prod` | Check OTEL collector |
| Grafana "No data" | Check time range | Adjust time picker, verify data sources |
| Loki permission denied | `ls -la data/loki-prod` | `sudo chmod 777 data/loki-prod` |

## Security Checklist

- [ ] `.env.production` not in git (check: `git status`)
- [ ] Strong passwords (24+ chars, generated)
- [ ] JWT secret 32+ chars
- [ ] Grafana admin password set (not default)
- [ ] UFW enabled with minimal ports
- [ ] SSH key authentication (disable password)
- [ ] Regular backups configured
- [ ] Cloudflare SSL mode: Full (strict)
- [ ] Grafana/Prometheus not exposed to internet (localhost only)

## Rollback Procedure

```bash
# 1. Stop current version
docker compose -f docker-compose.prod.yml down

# 2. Restore previous code
git checkout <previous-commit>

# 3. Rebuild frontend
cd apps/web && pnpm build && cd ../..

# 4. Restore database (if needed)
gunzip -c /path/to/backup.sql.gz | docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod

# 5. Start services
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

## File Locations

| Item | Path |
|------|------|
| Project root | `/home/vasyl/projects/onlinelib/onlinelib` |
| Production compose | `docker-compose.prod.yml` |
| Environment file | `.env.production` (not in git) |
| Nginx config | `/etc/nginx/sites-available/textstack` |
| Nginx config source | `infra/nginx-prod/textstack.conf` |
| Frontend dist | `apps/web/dist/` |
| Storage data | `data/storage/` |
| Database data | `data/postgres-prod/` |
| Grafana data | `data/grafana-prod/` |
| Prometheus data | `data/prometheus-prod/` |
| Loki data | `data/loki-prod/` |
| Backups | `/home/vasyl/backups/` |
| Observability docs | `observability/README.md` |

## See Also

- [Local Development](local-dev.md)
- [Backup & Restore](backup.md)
- [Observability Guide](../../observability/README.md)
- [API Documentation](../02-system/api.md)
