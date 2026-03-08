#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/2] Building and starting docker-compose services in detached mode..."
docker compose up -d --build

echo "[2/2] Building NanoClaw agent image..."
./container/build.sh

echo "Done. Orchestrator, Redis, and agent image are ready."