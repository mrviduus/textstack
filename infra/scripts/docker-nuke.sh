#!/bin/bash
set -e

echo "=== NUCLEAR CLEAN (removes ALL docker data) ==="
read -p "This removes ALL docker data system-wide. Continue? [y/N] " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker compose down -v --remove-orphans 2>/dev/null || true
    docker system prune -a -f --volumes
    rm -rf ./data
    echo "=== Nuked ==="
else
    echo "Aborted"
fi
# End of script