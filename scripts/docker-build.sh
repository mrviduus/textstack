#!/bin/bash
set -e

echo "=== Docker Build & Start ==="

# Ensure data dirs exist
mkdir -p ./data/postgres ./data/storage

# Build and start
docker compose build --no-cache
docker compose up -d

# Show status
echo ""
echo "=== Services ==="
docker compose ps

echo ""
echo "============================================"
echo "  OnlineLib is ready!"
echo "============================================"
echo ""
echo "  Main Services (via nginx):"
echo "  ├─ Web (General):     http://general.localhost"
echo "  ├─ Web (Programming): http://programming.localhost"
echo "  ├─ Admin Panel:       http://admin.localhost"
echo "  └─ API:               http://api.localhost"
echo ""
echo "  Direct Ports:"
echo "  ├─ API:               http://localhost:8080"
echo "  ├─ Web:               http://localhost:5173"
echo "  └─ Admin:             http://localhost:5174"
echo ""
echo "  Observability:"
echo "  ├─ Grafana:           http://localhost:3000  (admin/admin)"
echo "  └─ Prometheus:        http://localhost:9090"
echo ""
echo "  Database:"
echo "  └─ PostgreSQL:        localhost:5432 (app/changeme)"
echo "============================================"
