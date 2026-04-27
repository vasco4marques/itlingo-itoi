#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────
INSTALL_DIR="/home/theia"
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

# ── Workspace directory ─────────────────────────────────────────────
echo "==> Setting up workspace at ${INSTALL_DIR}..."
sudo mkdir -p "${INSTALL_DIR}"
sudo chown "$(whoami)" "${INSTALL_DIR}"
mkdir -p /tmp/theia/workspaces/tmp

# ── Clone repositories ──────────────────────────────────────────────
cd "${INSTALL_DIR}"

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
cd "${INSTALL_DIR}/rsl_vscode_extension"
yarn install
npx vsce package --allow-missing-repository

mkdir -p "${INSTALL_DIR}/pub/plugins/rsl-vscode-extension"
unzip -o *.vsix -d "${INSTALL_DIR}/pub/plugins/rsl-vscode-extension"

# ── Build ASL extension ────────────────────────────────────────────
echo "==> Building ASL extension..."
cd "${INSTALL_DIR}/asl_vscode_extension"
yarn install
npx vsce package --allow-missing-repository

mkdir -p "${INSTALL_DIR}/pub/plugins/asl-vscode-extension"
unzip -o *.vsix -d "${INSTALL_DIR}/pub/plugins/asl-vscode-extension"

# ── Clean up extension source ──────────────────────────────────────
echo "==> Cleaning up extension source dirs..."
rm -rf "${INSTALL_DIR}/rsl_vscode_extension" "${INSTALL_DIR}/asl_vscode_extension"

# ── Build Theia IDE ─────────────────────────────────────────────────
echo "==> Installing Theia dependencies (ignore-scripts to avoid race)..."
cd "${INSTALL_DIR}/pub"
yarn install --ignore-scripts

echo "==> Building itlingo-itoi extension..."
yarn workspace itlingo-itoi run build

echo "==> Rebuilding native modules..."
npm rebuild

echo "==> Building Theia browser app (this takes a while)..."
cd "${INSTALL_DIR}/pub/browser-app"
yarn theia build

echo ""
echo "============================================"
echo "  Build complete!"
echo "============================================"
echo ""

# ── Start the app ───────────────────────────────────────────────────
echo "==> Starting Theia IDE on port ${PORT}..."
exec yarn theia start --hostname 0.0.0.0 --port "${PORT}" --plugins=local-dir:../plugins
