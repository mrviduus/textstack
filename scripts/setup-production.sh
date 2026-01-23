#!/bin/bash
# Textstack Setup Script
# Run with: sudo ./scripts/setup-production.sh

set -e

echo "=== Textstack Setup ==="

if [ "$EUID" -ne 0 ]; then
    echo "Error: run as root (sudo)"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"

echo "Project: $PROJECT_DIR"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
    echo "Error: docker-compose.yml not found"
    exit 1
fi

echo "1. Installing packages..."
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx ufw

echo "2. Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "3. Installing nginx config..."
rm -f /etc/nginx/sites-enabled/default
sed "s|/home/vasyl/projects/onlinelib/textstack|$PROJECT_DIR|g" \
    "$PROJECT_DIR/infra/nginx/textstack.conf" > /etc/nginx/sites-available/textstack
ln -sf /etc/nginx/sites-available/textstack /etc/nginx/sites-enabled/
nginx -t
systemctl enable nginx
systemctl restart nginx

echo ""
echo "=== Done ==="
echo ""
echo "Next:"
echo "  1. cp .env.example .env && edit"
echo "  2. docker compose up -d"
echo "  3. sudo certbot --nginx -d textstack.app -d textstack.dev"
