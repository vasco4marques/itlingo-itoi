FROM node:22.22.2-bookworm

RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    python3 \
    python3-setuptools \
    libsecret-1-dev \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && npm install -g @vscode/vsce

RUN mkdir -p /tmp/theia/workspaces/tmp

WORKDIR /home/theia

# ── Clone repositories ───────────────────────────────────────────────
RUN git clone https://github.com/vasco4marques/rsl_vscode_extension.git \
 && git clone https://github.com/vasco4marques/asl_vscode_extension.git \
 && git clone https://github.com/vasco4marques/pub.git

# ── Build RSL extension ──────────────────────────────────────────────
WORKDIR /home/theia/rsl_vscode_extension
RUN yarn install && vsce package --allow-missing-repository
RUN mkdir -p /home/theia/pub/plugins/rsl-vscode-extension \
 && unzip *.vsix -d /home/theia/pub/plugins/rsl-vscode-extension

# ── Build ASL extension ──────────────────────────────────────────────
WORKDIR /home/theia/asl_vscode_extension
RUN yarn install && vsce package --allow-missing-repository
RUN mkdir -p /home/theia/pub/plugins/asl-vscode-extension \
 && unzip *.vsix -d /home/theia/pub/plugins/asl-vscode-extension

# ── Clean up extension source (no longer needed) ─────────────────────
RUN rm -rf /home/theia/rsl_vscode_extension /home/theia/asl_vscode_extension

# ── Build Theia IDE ──────────────────────────────────────────────────
# Avoid workspace lifecycle race: browser-app "prepare" runs theia build and can
# finish before itlingo-itoi has compiled lib/. Install without scripts, then build
# in the correct order.
WORKDIR /home/theia/pub
# --ignore-scripts avoids browser-app "prepare" racing before itlingo-itoi has lib/.
# `yarn rebuild:browser` / `theia rebuild:browser` does NOT compile natives on a fresh
# tree (it only reverts from .browser_modules when that cache exists). Run npm rebuild
# so node-gyp builds nsfw, node-pty, keytar, drivelist, etc.
RUN yarn install --ignore-scripts \
 && yarn workspace itlingo-itoi run build \
 && npm rebuild
WORKDIR /home/theia/pub/browser-app
RUN yarn theia build

# ── Runtime configuration ────────────────────────────────────────────
ENV PORT=3000
EXPOSE ${PORT}

WORKDIR /home/theia/pub/browser-app
CMD ["sh", "-c", "yarn theia start --hostname 0.0.0.0 --port ${PORT} --plugins=local-dir:../plugins"]
