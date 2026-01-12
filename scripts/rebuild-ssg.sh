#!/bin/bash
# Rebuild SSG static files
# Run this after publishing books to regenerate static HTML

set -e

echo "Starting SSG rebuild..."

# Ensure API is healthy before building
echo "Checking API health..."
if ! curl -sf http://localhost:8080/health > /dev/null; then
    echo "Error: API is not healthy. Start the stack first: docker compose up -d"
    exit 1
fi

# Run the SSG build
echo "Building static files..."
docker compose --profile build run --rm web-build

# Show what was generated
echo ""
echo "Build complete! Static files in volume 'static-web'"
echo "Nginx will serve these files automatically."

# Optional: Show generated pages count
PAGES=$(docker run --rm -v onlinelib_static-web:/data alpine find /data -name "*.html" 2>/dev/null | wc -l)
echo "Generated $PAGES HTML pages"
