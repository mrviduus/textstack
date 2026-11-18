#!/usr/bin/env bash
#
# One-shot host setup to let Docker pass the NVIDIA GPU into containers.
# Run this once on the prod box; afterwards every `deploy.yml` cycle is
# enough to apply compose changes.
#
# What it does:
#   1. Installs `nvidia-container-toolkit` from the official NVIDIA repo
#   2. Registers the `nvidia` runtime with the Docker daemon
#   3. Restarts dockerd (≈10–30 s downtime of all containers)
#
# Pre-flight: nvidia-smi must already work on the host. We've confirmed
# this — GTX 1650 Ti Mobile, driver loaded.
#
# Run:
#   ssh asus
#   bash <path>/install-nvidia-toolkit.sh
#
# Rollback (remove the runtime; doesn't uninstall the toolkit):
#   sudo rm /etc/docker/daemon.json
#   sudo systemctl restart docker
set -euo pipefail

if ! command -v nvidia-smi >/dev/null; then
    echo "ERROR: nvidia-smi not found — host driver missing. Aborting." >&2
    exit 1
fi

if dpkg -l 2>/dev/null | grep -q nvidia-container-toolkit; then
    echo "nvidia-container-toolkit already installed — skipping apt step"
else
    echo "==> Adding NVIDIA Container Toolkit repo"
    distro="$(. /etc/os-release; echo "$ID$VERSION_ID")"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL "https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list" \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null

    echo "==> apt-get update + install"
    sudo apt-get update -y
    sudo apt-get install -y nvidia-container-toolkit
fi

echo "==> Registering nvidia runtime with dockerd"
sudo nvidia-ctk runtime configure --runtime=docker

echo "==> Restarting docker daemon (≈10–30 s downtime)"
sudo systemctl restart docker

echo "==> Verifying"
sleep 5
sudo docker info 2>/dev/null | grep -iE "runtimes|nvidia" | head -5

echo "==> Smoke test: nvidia/cuda container sees the GPU"
sudo docker run --rm --gpus all --runtime=nvidia \
    nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi -L \
    || { echo "ERROR: smoke test failed"; exit 1; }

echo
echo "DONE. Now safe to push docker-compose.yml changes that add runtime:nvidia"
echo "to the ollama service. The orchestrated deploy will restart ollama with"
echo "GPU access — expect 'ggml_cuda_init' lines in the container logs."
