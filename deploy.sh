#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/digital_ocean}"
SSH_TARGET="${SSH_TARGET:-vmarques@46.101.130.155}"
REMOTE_DIR="${REMOTE_DIR:-/opt/microservices/itlingo-itoi}"

DOCKER_REPOSITORY="${DOCKER_REPOSITORY:-vasco4marques}"
TAG="$(git -C "$SCRIPT_DIR" rev-parse --short=7 HEAD)"

API_IMAGE="${DOCKER_REPOSITORY}/itoi:${TAG}"
LSP_IMAGE="${DOCKER_REPOSITORY}/itoi-lsp:${TAG}"

# Local dev mode: build the images as :latest and restart the local compose
# stack — no push, no SSH. Trigger with `./deploy.sh --local` or `LOCAL=1 ./deploy.sh`.
# Leaving API_IMAGE/LSP_IMAGE unset makes docker-compose.yml fall back to its
# `:latest` defaults, so `compose build` tags exactly what `compose up` runs.
if [[ "${1:-}" == "--local" || "${LOCAL:-}" == "1" ]]; then
    echo "Local dev deploy: building :latest and restarting the compose stack"
    cd "$SCRIPT_DIR"
    unset API_IMAGE LSP_IMAGE
    docker compose build --no-cache
    docker compose down
    docker compose up -d
    docker compose ps
    echo "Local dev deploy complete."
    exit 0
fi

build_and_push() {
    local service_name="$1"
    local build_context="$2"
    local image="$3"

    echo "[$service_name] Building $image"
    docker build --no-cache --tag "$image" "$build_context"

    echo "[$service_name] Pushing $image"
    docker push "$image"

    echo "[$service_name] Build and push complete"
}

echo "Deploying commit $TAG"

build_and_push \
    "api" \
    "$SCRIPT_DIR" \
    "$API_IMAGE" &
api_pid=$!

build_and_push \
    "lsp" \
    "$SCRIPT_DIR/dsl-lsp-service" \
    "$LSP_IMAGE" &
lsp_pid=$!

trap 'kill "$api_pid" "$lsp_pid" 2>/dev/null || true' INT TERM

build_failed=0

if ! wait "$api_pid"; then
    echo "[api] Build or push failed" >&2
    build_failed=1
fi

if ! wait "$lsp_pid"; then
    echo "[lsp] Build or push failed" >&2
    build_failed=1
fi

trap - INT TERM

if ((build_failed)); then
    echo "Deployment aborted because at least one image failed to publish." >&2
    exit 1
fi

echo "Both images published. Deploying to $SSH_TARGET"

echo "Uploading hardened Compose and LSP proxy configuration"
ssh -i "$SSH_KEY" "$SSH_TARGET" \
    "mkdir -p '$REMOTE_DIR/dsl-lsp-service'"
scp -i "$SSH_KEY" \
    "$SCRIPT_DIR/docker-compose.yml" \
    "$SSH_TARGET:$REMOTE_DIR/docker-compose.yml"
scp -i "$SSH_KEY" \
    "$SCRIPT_DIR/dsl-lsp-service/cloud-proxy.conf.template" \
    "$SSH_TARGET:$REMOTE_DIR/dsl-lsp-service/cloud-proxy.conf.template"

ssh -i "$SSH_KEY" "$SSH_TARGET" bash -s -- \
    "$REMOTE_DIR" "$API_IMAGE" "$LSP_IMAGE" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

remote_dir="$1"
api_image="$2"
lsp_image="$3"

cd "$remote_dir"

# Persist the deployed tags in .env so `${API_IMAGE}`/`${LSP_IMAGE}` in
# docker-compose.yml resolve to this exact commit even on a later bare
# `docker compose up` or a reboot — the tag must not live only in this shell.
upsert_env() {
    local key="$1" value="$2"
    touch .env
    if grep -q "^${key}=" .env; then
        sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
        printf '%s=%s\n' "$key" "$value" >> .env
    fi
}

upsert_env API_IMAGE "$api_image"
upsert_env LSP_IMAGE "$lsp_image"

# Also export for this shell so substitution is unambiguous regardless of
# where compose reads .env from.
export API_IMAGE="$api_image"
export LSP_IMAGE="$lsp_image"

echo "Pulling $api_image and $lsp_image"
docker compose pull

echo "Restarting services"
docker compose down
docker compose up -d --no-build

docker compose ps
REMOTE_SCRIPT

echo "Deployment of commit $TAG completed successfully."
