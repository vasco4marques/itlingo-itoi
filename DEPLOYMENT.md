# Deployment

How ITOI is built and deployed to the production host. For runtime configuration
(env vars, the DSL LSP sidecar, nginx `/dsl-lsp/` routing) see `readme.md`.

## Overview

`deploy.sh` builds two images tagged with the **current commit**, pushes them to
Docker Hub, then SSHes into the host and rolls the stack over to those tags.

| Image | Build context | Runs as |
| --- | --- | --- |
| `vasco4marques/itoi:<commit>` | repo root (`Dockerfile`) | `api` (Theia IDE, port 3000) |
| `vasco4marques/itoi-lsp:<commit>` | `dsl-lsp-service/` | `lsp` (DSL language service, port 3001 → host 3002) |

`<commit>` is `git rev-parse --short=7 HEAD`, so **every deploy is pinned to a
commit** — no floating `latest`. Commit your changes before deploying; the tag
reflects `HEAD`, not the working tree.

## Prerequisites

- `docker` logged in to the `vasco4marques` Docker Hub account (`docker login`).
- SSH access to the host: `ssh -i ~/.ssh/digital_ocean vmarques@46.101.130.155`
  (overridable via `SSH_KEY` / `SSH_TARGET` env vars).
- The remote deploy dir already provisioned: `/opt/microservices/itlingo-itoi`
  (`docker-compose.yml`, `.env`, `db/init.sql`). Overridable via `REMOTE_DIR`.

## Deploy

```bash
./deploy.sh
```

What it does:

1. Builds `vasco4marques/itoi:<commit>` and `vasco4marques/itoi-lsp:<commit>`
   in parallel with `--no-cache`, and pushes both. Aborts if either fails.
2. Uploads the repository's `docker-compose.yml` and the restricted LSP Cloud
   proxy template so the runtime hardening cannot lag behind the images.
3. SSHes to the host and, in `$REMOTE_DIR`:
   - **Upserts** `API_IMAGE=…:<commit>` and `LSP_IMAGE=…:<commit>` into the
     remote `.env` so the tag is durable (see "Why the tag lives in .env").
   - `docker compose pull` → `down` → `up -d --no-build`.
4. Prints `docker compose ps`.

Override any of the defaults inline, e.g.:

```bash
REMOTE_DIR=/opt/microservices/itlingo-itoi SSH_TARGET=vmarques@46.101.130.155 ./deploy.sh
```

## Why the tag lives in `.env`

The server `docker-compose.yml` references the images by variable:

```yaml
api:
  image: ${API_IMAGE:-vasco4marques/itoi:latest}
  restart: unless-stopped
lsp:
  image: ${LSP_IMAGE:-vasco4marques/itoi-lsp:latest}
  restart: unless-stopped
```

`deploy.sh` writes the deployed tags into `.env`, which Compose reads
automatically. This makes the deployed commit **survive a reboot or a bare
`docker compose up`** — if the tag only lived in an ephemeral override or an
exported shell variable, the next recreate would silently fall back to
`:latest` (a stale image) and the deploy would appear to "disappear".
`restart: unless-stopped` brings the containers back after a host reboot.

## Reverse proxy (nginx)

nginx on the host terminates TLS for `itoi.itlingo.pt` and fronts two origins.
Both `location` blocks must exist — the second is easy to forget and its
absence makes the DSL language features silently fail (requests fall through to
Theia, which answers `Cannot GET /dsl-lsp/dsls`).

| Path | Upstream | Purpose |
| --- | --- | --- |
| `location /` | `127.0.0.1:3000` | Theia IDE (`api`) + its WebSocket |
| `location /dsl-lsp/` | `127.0.0.1:3002` | DSL LSP sidecar (`lsp`), HTTP + `/lsp/<id>` WebSocket |

The full `/dsl-lsp/` block (prefix-stripping `proxy_pass` + WebSocket upgrade
headers) is documented in `readme.md` → "Reverse-proxy routing (production)".
`deploy.sh` does **not** manage nginx; changes there are applied on the host
directly (`/etc/nginx/sites-available/itlingo-itoi`, then `sudo nginx -t &&
sudo systemctl reload nginx`).

## Verify a deploy

```bash
# on the host
cd /opt/microservices/itlingo-itoi
docker compose ps                        # api + lsp on the new <commit>, db healthy
grep -E '^(API_IMAGE|LSP_IMAGE)=' .env   # both point at the deployed commit

# through the public domain
curl -s -o /dev/null -w '%{http_code}\n' https://itoi.itlingo.pt/            # 200 (Theia)
curl -s https://itoi.itlingo.pt/dsl-lsp/health                               # {"status":"ok",…}
```

In the browser, hard-reload the IDE: the `itlingo-dsl-runtime` extension fetches
the DSL list at startup, so a stale tab won't pick up a new deploy.

## Rollback

Point `.env` at a previous commit tag and bring the stack up:

```bash
cd /opt/microservices/itlingo-itoi
sed -i 's|^API_IMAGE=.*|API_IMAGE=vasco4marques/itoi:<oldcommit>|' .env
sed -i 's|^LSP_IMAGE=.*|LSP_IMAGE=vasco4marques/itoi-lsp:<oldcommit>|' .env
docker compose pull && docker compose up -d --no-build
```

## Troubleshooting

- **"My change didn't deploy / I see an old version."** Confirm the tag:
  `docker compose ps` should show the images on the current `<commit>`, and
  `.env` should match. If they show `:latest`, `.env` wasn't updated — re-run
  `deploy.sh`. Remember the tag is `HEAD`, so uncommitted work is not deployed.
- **DSL editor support missing (no diagnostics/completion for `.rslx` etc.).**
  Check `curl https://itoi.itlingo.pt/dsl-lsp/health`. If it returns Theia HTML
  or `Cannot GET`, the nginx `location /dsl-lsp/` block is missing — see above.
- **Import from ITLingo Cloud button is disabled** ("Importing is only available
  for users with write access"). This is an auth state, not a deploy issue: the
  session has no write access (`GET /getWorkspace` → 401 when reached without a
  valid ITLingo Cloud launch session). Enter ITOI through the ITLingo Cloud flow
  rather than opening the URL directly.
