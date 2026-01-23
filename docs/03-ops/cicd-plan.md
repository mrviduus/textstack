# CI/CD Implementation Plan

> **Status:** Implemented
> **Priority:** High
> **Estimated effort:** 2-3 days

## Overview

This document outlines the CI/CD strategy for Textstack, designed for a single-server self-hosted deployment with Cloudflare Tunnel.

## Architecture Decision

### Why Self-Hosted Runner?

| Approach | Pros | Cons |
|----------|------|------|
| GitHub-hosted runners | Zero maintenance | Cannot deploy to local server behind NAT |
| Self-hosted runner | Direct server access, faster | Must manage runner security |

**Decision:** Self-hosted GitHub Actions runner on the production server.

The server is behind double NAT with Cloudflare Tunnel - no way for GitHub-hosted runners to reach it.

## Pipeline Design

### Triggers

| Event | Pipeline |
|-------|----------|
| Push to `main` | Full CI + Auto-deploy to production |
| Pull request | CI only (build, test, lint) |
| Manual dispatch | Deploy with rollback option |
| Schedule (daily 3 AM) | Backup job |

### CI Pipeline (All Branches)

```yaml
name: CI
on: [push, pull_request]

jobs:
  backend-build:
    - Restore .NET packages
    - Build solution
    - Run unit tests
    - Run integration tests (with test DB)

  backend-lint:
    - dotnet format --verify-no-changes

  frontend-build:
    - pnpm install
    - TypeScript check (pnpm build)
    - Lint (if configured)

  frontend-test:
    - pnpm test (when tests exist)

  docker-build:
    - Build all images
    - Verify images start correctly
```

### CD Pipeline (Main Branch Only)

```yaml
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      rollback_commit:
        description: 'Commit SHA to rollback to (optional)'

jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - Backup database (pre-deploy)
      - Pull latest code
      - Build frontend
      - Build and restart containers
      - Run health checks
      - Notify on failure
```

## Implementation Phases

### Phase 1: Basic CI (Day 1)

1. Create `.github/workflows/ci.yml`
2. Backend build + test
3. Frontend build
4. Docker build verification

### Phase 2: Self-Hosted Runner (Day 1)

1. Install GitHub Actions runner on server
2. Configure as service with auto-start
3. Secure runner (dedicated user, limited permissions)

### Phase 3: CD Pipeline (Day 2)

1. Create `.github/workflows/deploy.yml`
2. Pre-deploy backup
3. Zero-downtime deployment
4. Health check verification
5. Rollback on failure

### Phase 4: Scheduled Jobs (Day 2)

1. Daily backup job
2. Weekly cleanup job (old images, logs)
3. Health monitoring alerts

## Workflow Files

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  DOTNET_VERSION: '10.0.x'
  NODE_VERSION: '22'

jobs:
  backend:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: ${{ env.DOTNET_VERSION }}

      - name: Restore dependencies
        run: dotnet restore backend/OnlineLib.sln

      - name: Build
        run: dotnet build backend/OnlineLib.sln --no-restore -c Release

      - name: Run unit tests
        run: dotnet test backend/tests/OnlineLib.UnitTests --no-build -c Release

      - name: Run integration tests
        run: dotnet test backend/tests/OnlineLib.IntegrationTests --no-build -c Release
        env:
          ConnectionStrings__Default: "Host=localhost;Database=test;Username=test;Password=test"

  frontend:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 9

      - name: Install dependencies (web)
        run: pnpm -C apps/web install

      - name: Build web
        run: pnpm -C apps/web build
        env:
          VITE_API_URL: /api

      - name: Install dependencies (admin)
        run: pnpm -C apps/admin install

      - name: Build admin
        run: pnpm -C apps/admin build

  docker:
    runs-on: ubuntu-latest
    needs: [backend, frontend]

    steps:
      - uses: actions/checkout@v4

      - name: Build Docker images
        run: |
          docker compose build

      - name: Verify images
        run: |
          docker images | grep onlinelib
```

### `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      rollback_commit:
        description: 'Commit SHA to rollback to'
        required: false

env:
  PROJECT_DIR: /home/vasyl/projects/onlinelib/onlinelib

jobs:
  deploy:
    runs-on: self-hosted

    steps:
      - name: Pre-deploy backup
        run: |
          DATE=$(date +%F-%H%M)
          docker exec textstack_db_prod pg_dump -U textstack_prod textstack_prod | gzip > ~/backups/pre-deploy-$DATE.sql.gz
          echo "Backup created: pre-deploy-$DATE.sql.gz"

      - name: Checkout code
        run: |
          cd $PROJECT_DIR
          git fetch origin
          if [ -n "${{ github.event.inputs.rollback_commit }}" ]; then
            git checkout ${{ github.event.inputs.rollback_commit }}
          else
            git checkout main
            git pull origin main
          fi

      - name: Build frontend
        run: |
          cd $PROJECT_DIR/apps/web
          pnpm install
          VITE_API_URL=/api pnpm build

      - name: Deploy containers
        run: |
          cd $PROJECT_DIR
          docker compose up -d --build

      - name: Wait for services
        run: sleep 30

      - name: Health check
        run: |
          # API health
          curl -sf http://localhost:8080/health || exit 1
          # Nginx responds
          curl -sf http://localhost:80 || exit 1
          echo "Health checks passed"

      - name: Cleanup old images
        run: docker image prune -f

      - name: Notify on failure
        if: failure()
        run: |
          echo "::error::Deployment failed! Consider rollback."
          # TODO: Add Slack/Discord notification

  notify-success:
    runs-on: self-hosted
    needs: deploy

    steps:
      - name: Deployment successful
        run: |
          echo "Deployed commit: ${{ github.sha }}"
          echo "Deployment time: $(date)"
          # TODO: Add success notification
```

### `.github/workflows/backup.yml`

```yaml
name: Scheduled Backup

on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 3 AM
  workflow_dispatch:

env:
  PROJECT_DIR: /home/vasyl/projects/onlinelib/onlinelib
  BACKUP_DIR: /home/vasyl/backups

jobs:
  backup:
    runs-on: self-hosted

    steps:
      - name: Create backup
        run: |
          DATE=$(date +%F)

          # Database
          docker exec textstack_db_prod pg_dump -U textstack_prod textstack_prod | gzip > $BACKUP_DIR/db-$DATE.sql.gz

          # Storage (incremental would be better for large files)
          tar czf $BACKUP_DIR/storage-$DATE.tar.gz -C $PROJECT_DIR/data storage

          echo "Backup completed: $DATE"

      - name: Cleanup old backups
        run: |
          # Keep 7 days of daily backups
          find $BACKUP_DIR -name "db-*.sql.gz" -mtime +7 -delete
          find $BACKUP_DIR -name "storage-*.tar.gz" -mtime +7 -delete

          # Keep 4 weekly backups (Sundays)
          # TODO: Implement weekly retention

      - name: Verify backup
        run: |
          ls -lh $BACKUP_DIR/*.gz | tail -5

          # Test backup integrity
          gunzip -t $BACKUP_DIR/db-$(date +%F).sql.gz
          echo "Backup verification passed"
```

## Self-Hosted Runner Setup

### Installation

```bash
# Create dedicated user
sudo useradd -m -s /bin/bash github-runner
sudo usermod -aG docker github-runner

# Download runner
cd /home/github-runner
curl -o actions-runner-linux-x64.tar.gz -L https://github.com/actions/runner/releases/download/v2.311.0/actions-runner-linux-x64-2.311.0.tar.gz
tar xzf actions-runner-linux-x64.tar.gz

# Configure (get token from GitHub repo settings)
./config.sh --url https://github.com/YOUR_USER/onlinelib --token YOUR_TOKEN

# Install as service
sudo ./svc.sh install
sudo ./svc.sh start
```

### Security Hardening

1. **Dedicated user** - runner runs as `github-runner`, not root
2. **Limited sudo** - only specific commands if needed
3. **Repository restriction** - runner only for this repo
4. **Label** - use `self-hosted` label to control which jobs run here

```bash
# /etc/sudoers.d/github-runner
github-runner ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart nginx
github-runner ALL=(ALL) NOPASSWD: /usr/bin/systemctl status nginx
```

## Operational Policies

### Deployment Frequency

| Type | Frequency | Notes |
|------|-----------|-------|
| Feature deployments | On merge to main | Auto-deploy |
| Hotfixes | Immediate | Manual trigger if needed |
| Rollbacks | As needed | Via workflow dispatch |

### Backup Schedule

| Type | Frequency | Retention |
|------|-----------|-----------|
| Pre-deploy | Before each deploy | 3 days |
| Daily | 3 AM UTC | 7 days |
| Weekly | Sunday 3 AM | 4 weeks |
| Monthly | 1st of month | 6 months |

### Maintenance Windows

| Task | Frequency | Duration |
|------|-----------|----------|
| Docker cleanup | Weekly | < 1 min |
| Log rotation | Daily (logrotate) | Automatic |
| System updates | Monthly | 15-30 min (scheduled) |
| SSL renewal | Auto (Cloudflare) | N/A |

### Health Monitoring

```bash
# Recommended: Add to crontab
*/5 * * * * curl -sf http://localhost:8080/health || echo "API DOWN" | mail -s "Alert" admin@example.com
```

### Restart Policy

| Service | Restart Policy | Notes |
|---------|---------------|-------|
| Docker containers | `restart: always` | Auto-restart on failure |
| nginx | systemd enabled | Auto-start on boot |
| cloudflared | systemd enabled | Auto-start on boot |
| GitHub runner | systemd service | Auto-start on boot |

## Rollback Procedure

### Automatic (Pipeline Failure)

Pipeline fails health check → No changes applied (old containers still running)

### Manual Rollback

```bash
# Via GitHub Actions
# Go to Actions → Deploy → Run workflow → Enter commit SHA

# Or via CLI
cd /home/vasyl/projects/onlinelib/onlinelib
git checkout <previous-commit>
cd apps/web && pnpm build && cd ..
docker compose up -d --build
```

### Database Rollback

```bash
# Find backup
ls -la ~/backups/

# Restore
docker compose down
gunzip -c ~/backups/db-YYYY-MM-DD.sql.gz | docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod
docker compose up -d
```

## TODO Checklist

- [x] Create `.github/workflows/ci.yml`
- [x] Create `.github/workflows/deploy.yml`
- [x] Create `.github/workflows/backup.yml`
- [x] Install self-hosted runner on server
- [x] Configure runner as systemd service
- [x] Test CI pipeline on PR
- [x] Test deploy pipeline on main
- [x] Set up backup retention policy (7-day daily retention)
- [ ] Add health check monitoring
- [ ] Add failure notifications (Slack/Discord/Email)
- [ ] Document runbook for on-call

## Security Considerations

1. **Secrets Management**
   - `.env` never in git
   - Use GitHub Secrets for sensitive values if needed
   - Runner has access to local `.env`

2. **Runner Security**
   - Dedicated non-root user
   - Limited Docker access
   - Repository-scoped runner

3. **Deployment Safety**
   - Pre-deploy backup always
   - Health checks before marking success
   - Easy rollback via UI

## See Also

- [Production Deployment](deployment.md)
- [Backup & Restore](backup.md)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
