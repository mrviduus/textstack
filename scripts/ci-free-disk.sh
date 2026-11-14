#!/bin/bash
# Make room for the compose build on a GitHub-hosted runner (ci.yml: docker, e2e).
#
# Deleting the preinstalled toolchains took 2-7 minutes per job (2026-11-14: e2e
# 433s of 13m). The same day's runners had one 145G disk with 88G free and no
# separate /mnt, so the delete bought nothing. Delete only when the disk Docker
# writes to is short of room; print df either way, so a smaller runner shows up.
set -euo pipefail

NEED_GB=${NEED_GB:-40}

root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
df -h / "$root" 2>/dev/null || true
free_gb=$(df -BG --output=avail "$root" 2>/dev/null | tail -1 | tr -dc 0-9)

if [ "${free_gb:-0}" -ge "$NEED_GB" ]; then
  echo "${free_gb}G free for Docker (need ${NEED_GB}G): nothing to delete"
  exit 0
fi

echo "${free_gb:-?}G free for Docker (need ${NEED_GB}G): deleting preinstalled toolchains"
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache
docker system prune -af
df -h / "$root" 2>/dev/null || true
