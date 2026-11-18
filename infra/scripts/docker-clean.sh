#!/bin/bash
set -e

echo "=== Docker Full Clean ==="

# Stop all project containers
echo "Stopping containers..."
docker compose down -v --remove-orphans 2>/dev/null || true

# Remove project images
echo "Removing project images..."
docker images --filter "reference=*books*" -q | xargs -r docker rmi -f 2>/dev/null || true
docker images --filter "reference=*textstack*" -q | xargs -r docker rmi -f 2>/dev/null || true

# Remove dangling images
echo "Removing dangling images..."
docker image prune -f

# Remove unused volumes
echo "Removing unused volumes..."
docker volume prune -f

# Remove build cache
echo "Removing build cache..."
docker builder prune -f

# Optional: remove data dir (uncomment if needed)
# echo "Removing data directory..."
# rm -rf ./data

echo "=== Clean Complete ==="
