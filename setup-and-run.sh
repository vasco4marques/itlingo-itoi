#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────
# Everything is built relative to wherever you run this script from.
BASE_DIR="$(pwd)"
PORT="${PORT:-3000}"
NODE_MAJOR=22

# ── System dependencies (Debian/Ubuntu) ────────────────────────────
echo "==> Installing system packages..."
sudo apt-get update
sudo apt-get install -y \
    git \
    build-essential \
    python3 \
    python3-setuptools \
    libsecret-1-dev \
    unzip \
    curl \
    ca-certificates \
    gnupg

# ── Node.js (if not already installed) ─────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
    echo "==> Installing Node.js ${NODE_MAJOR}.x..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "    Node $(node -v)  npm $(npm -v)"

# ── Yarn ────────────────────────────────────────────────────────────
echo "==> Enabling corepack..."
sudo corepack enable

# ── Workspace temp directory ────────────────────────────────────────
mkdir -p /tmp/theia/workspaces/tmp

# ── Clone repositories ──────────────────────────────────────────────
cd "${BASE_DIR}"

for repo in rsl_vscode_extension asl_vscode_extension pub; do
    if [ -d "${repo}" ]; then
        echo "    ${repo}/ already exists, pulling latest..."
        git -C "${repo}" pull --ff-only || true
    else
        echo "    Cloning ${repo}..."
        git clone "https://github.com/vasco4marques/${repo}.git"
    fi
done

# ── Build RSL extension ────────────────────────────────────────────
echo "==> Building RSL extension..."
cd "${BASE_DIR}/rsl_vscode_extension"
yarn install
npx vsce package --allow-missing-repository

mkdir -p "${BASE_DIR}/pub/plugins/rsl-vscode-extension"
unzip -o *.vsix -d "${BASE_DIR}/pub/plugins/rsl-vscode-extension"

# ── Build ASL extension ────────────────────────────────────────────
echo "==> Building ASL extension..."
cd "${BASE_DIR}/asl_vscode_extension"
yarn install
npx vsce package --allow-missing-repository

mkdir -p "${BASE_DIR}/pub/plugins/asl-vscode-extension"
unzip -o *.vsix -d "${BASE_DIR}/pub/plugins/asl-vscode-extension"

# ── Clean up extension source ──────────────────────────────────────
echo "==> Cleaning up extension source dirs..."
rm -rf "${BASE_DIR}/rsl_vscode_extension" "${BASE_DIR}/asl_vscode_extension"

# ── Build Theia IDE ─────────────────────────────────────────────────
echo "==> Installing Theia dependencies (ignore-scripts to avoid race)..."
cd "${BASE_DIR}/pub"
yarn install --ignore-scripts

echo "==> Building itlingo-itoi extension..."
cd "${BASE_DIR}/pub/itlingo-itoi"
yarn build

echo "==> Rebuilding native modules..."
cd "${BASE_DIR}/pub"
npm rebuild

echo "==> Building Theia browser app (this takes a while)..."
cd "${BASE_DIR}/pub/browser-app"
yarn theia build

echo ""
echo "============================================"
echo "  Build complete!"
echo "============================================"
echo ""

# ── Start the app ───────────────────────────────────────────────────
echo "==> Starting Theia IDE on port ${PORT}..."
exec yarn theia start --hostname 0.0.0.0 --port "${PORT}" --plugins=local-dir:../plugins
