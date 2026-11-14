#!/bin/bash
# Make room for the compose build on a GitHub-hosted runner (ci.yml: docker, e2e).
#
# The runner's root disk is nearly full; its temp disk /mnt is nearly empty.
# Deleting the preinstalled toolchains frees the root disk but took 2-7 minutes
# per job (2026-11-14: e2e 433s of 13m). Bind-mounting Docker's and containerd's
# stores onto /mnt takes seconds and gives the build more room than the delete did.
# Both stores, because with the containerd image store the images live in
# /var/lib/containerd, not in Docker's data root. Nothing preinstalled is lost
# that a job needs: the old step pruned every image anyway.
#
# Falls back to the delete when /mnt is missing or small.
set -euo pipefail

NEED_GB=${NEED_GB:-30}

avail_gb() { df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc 0-9; }

df -h / /mnt 2>/dev/null || true

mnt_gb=$(avail_gb /mnt || true)
if mountpoint -q /mnt && [ "${mnt_gb:-0}" -ge "$NEED_GB" ]; then
  echo "Docker and containerd stores -> /mnt (${mnt_gb}G free there)"
  sudo systemctl stop docker.socket docker containerd
  for d in docker containerd; do
    sudo mkdir -p "/mnt/$d" "/var/lib/$d"
    sudo mount --bind "/mnt/$d" "/var/lib/$d"
  done
  sudo systemctl start containerd docker
  docker info --format 'Docker root: {{.DockerRootDir}}'
else
  echo "/mnt has ${mnt_gb:-no}G free (need ${NEED_GB}G): deleting preinstalled toolchains instead"
  sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache
  docker system prune -af
fi

df -h / /mnt 2>/dev/null || true
