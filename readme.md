<br/>
<div id="theia-logo" align="center">
    <br />
    <img src="https://raw.githubusercontent.com/eclipse-theia/theia/master/logo/theia-logo.svg?sanitize=true" alt="Theia Logo" width="300"/>
     <h3>Cloud & Desktop IDE Platform</h3>
</div>
<br>


# Itoi Theia IDE on Heroku

This repositorty includes image to run a single theia instance, and a docker-compose that couples it to a database.

## Instalation

Install docker compose

[https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)

Clone this repository and inside the folder run:

```
docker build . -t itoi
docker compose up
```

This should build and run the containers, you can confirm this through the Docker interface or running:

```
docker container ls
```

You can now access Theia through:

[http://127.0.0.1:3000/](http://127.0.0.1:3000/)

## Configuration

All runtime configuration is done through environment variables. Defaults are baked into the source so the container also runs without any of them set, but anything sensitive (DB connection, crypto keys) should always be overridden in real deployments.

### Application

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | (unset) | Postgres connection string used by the pg `Pool` (e.g. `postgres://user:pass@host:5432/itlingo`). Required for workspace persistence; without it DB operations fail. |
| `ITOI_PROD` | (unset) | When set to `DEV`, disables SSL on the Postgres pool, lowers the default `LOG_LEVEL` to `debug`, and turns on pretty-printed logs. Any other value (or unset) is treated as production. |
| `ITLINGO_CLOUD_URL` | `http://localhost:8069/` | Base URL of the ITLingo Cloud service used by `/setupCustom`, `/setupCustomAccepted` and unauthenticated redirects (`/createTempWorkspace` when no token is present). |
| `COM_KEY` | hardcoded fallback | AES-256-CBC key used to decrypt the `iv`/`t` token pair received on `/createTempWorkspace`. Must match the key ITLingo Cloud encrypts with. **Override in production.** |
| `COOKIE_KEY` | hardcoded fallback | Secret used to sign `express-session` cookies. **Override in production.** |
| `HOST_FS` | `/tmp/theia/workspaces/` | Filesystem root where per-session workspace folders (`<HOST_FS>/tmp/<uuid>/<workspace>`) and the nsfw watcher target live. Must be writable by the Theia user. |
| `HOST_ROOT` | `/home/theia/ide/` | Path inside the container where helper scripts such as `gitUtils/cloneScript.sh` are located. |
| `PORT` | `3000` (compose) | Port Theia binds to. Used by the Heroku `run` command and the docker-compose `CMD`. |
| `NODE_ENV` | `production` (compose) | Standard Node env flag; some Theia internals branch on this. |
| `DSL_LSP_PUBLIC_URL` | `http://localhost:3002` | URL where the user's **browser** reaches the dsl-lsp-service sidecar. Served to the frontend by the `itlingo-dsl-runtime` extension via `GET /dslservice/config`. |

### Dynamic DSL language service (dsl-lsp-service)

The `dsl-lsp-service/` sidecar gives ITOI editor support (live diagnostics, completion, hover, go-to-definition) for **any** DSL registered in ITLingoCloud, without building a per-DSL extension. It runs as its own container (`lsp` in docker-compose):

1. At session start, the `itlingo-dsl-runtime` Theia extension reads the launch tokens from `GET /getWorkspace` and asks the sidecar (`GET /dsls?iv=..&t=..`) which DSLs exist.
2. The sidecar fetches active and draft DSL grammars from ITLingoCloud (`GET {ITLINGO_CLOUD_URL}token_api/get-dsls`, authenticated with the forwarded launch token) and answers with registration metadata.
3. The frontend registers each DSL in Monaco (language id `itlingo-<acronym>` for an active grammar, `itlingo-<acronym>-draft` for its newest draft) and opens one LSP WebSocket per language (`ws://…/lsp/<languageId>?iv=..&t=..`). The sidecar builds a Langium language server from the grammar text at runtime (`createServicesForGrammar`, Langium pinned to the same version ITLingoCloud validates grammars with).

RSL and ASL use this same dynamic path and are available only when ordinary,
published records for them exist in ITLingoCloud. Their legacy extension source
folders remain in the repository for history but are not built into the image.
For each acronym, the newest active version remains on its canonical extension
(for example `.psl`) while its newest draft is served alongside it at the
`-draft` extension (for example `.psl-draft`). A draft without an active version
is still served only at `-draft`. Grammar changes are picked up on the next IDE
reload (the sidecar caches the DSL list for `DSL_CACHE_TTL_MS`, default 60 s).

Sidecar environment:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | Port the sidecar listens on inside the container. |
| `ITLINGO_CLOUD_URL` | `http://localhost:8069/` | Base URL of ITLingoCloud (Odoo). |
| `RESERVED_EXTENSIONS` | empty | Optional comma-separated extensions an operator wants to exclude from dynamic registration. |
| `DSL_CACHE_TTL_MS` | `60000` | How long a fetched DSL list is reused per session token. |
| `DSL_LSP_HOST_PORT` | `3002` (compose) | Host port the sidecar is published on; keep `DSL_LSP_PUBLIC_URL` in sync. |

#### Reverse-proxy routing (production)

The sidecar is a **separate origin** from the Theia backend, so the reverse proxy must route `/dsl-lsp/` to it — otherwise `GET /dsl-lsp/dsls` and the `wss://…/dsl-lsp/lsp/<languageId>` WebSocket fall through to Theia, which answers `Cannot GET /dsl-lsp/dsls` and no DSL is registered. On the production host the sidecar is published on `127.0.0.1:${DSL_LSP_HOST_PORT}` (bound to localhost; nginx is the only public entry) and `DSL_LSP_PUBLIC_URL=https://itoi.itlingo.pt/dsl-lsp`. Add this `location` block to the `itoi.itlingo.pt` server (alongside `location /`, which proxies Theia on `:3000`):

```nginx
# needs the `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`
# block that the Theia location already relies on.
location /dsl-lsp/ {
    proxy_pass http://127.0.0.1:3002/;          # trailing slash strips the /dsl-lsp prefix
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;   # WebSocket for /lsp/<languageId>
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering     off;
}
```

The trailing slash on `proxy_pass` maps `/dsl-lsp/dsls → /dsls` and `/dsl-lsp/lsp/<id> → /lsp/<id>` (matching the sidecar's `^/lsp/[^/]+$` upgrade check). Verify with `curl https://itoi.itlingo.pt/dsl-lsp/health` (expect `{"status":"ok",…}`). `deploy.sh` does not manage nginx, so this must be applied on the host directly.

### Logging

The Itoi extension uses a small zero-dependency logger on both the backend (writes to stdout/stderr) and the frontend (writes to the browser console). Every log line carries an ISO timestamp, a level and a namespace (`db`, `http`, `workspace`, `watcher`, `git`, `itlingo-cloud`, `itoi-server`, `itoi-client`, `fs`, `setup`).

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` (or `debug` when `ITOI_PROD=DEV`) | Minimum level printed. One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |
| `LOG_PRETTY` | on when `ITOI_PROD=DEV`, off otherwise | `true` / `1` forces human-readable colored output to stdout/stderr; `false` / `0` forces single-line JSON (good for log shippers). |

Frontend log level is read from `window.localStorage.LOG_LEVEL`; you can change it from DevTools without rebuilding:

```
localStorage.LOG_LEVEL = 'debug'; location.reload();
```

Set it to `silent` to disable all extension logs in the browser console.

Examples:

```
LOG_LEVEL=debug docker compose up
LOG_PRETTY=true LOG_LEVEL=trace yarn --cwd ide/browser-app start
```

What each namespace covers:

- `db` — pg pool lifecycle and every stored procedure call (`fn_pullfiles`, `sp_insertfiles`, `sp_changefile`, `sp_deleteFile`, `sp_updatefilename`, `sp_assignGit`, `fn_getgitrepo`) with workspace/file context and errors.
- `http` — one structured access log per request (method, path, status, duration, hashed session id) plus per-route entries.
- `workspace` — creation vs reuse of workspaces, folder paths, file pulls from storage, workspace switching from the frontend.
- `watcher` — file create/modify/delete/rename events from the nsfw watcher.
- `git` — clone / pull / push / checkout / branch outcomes.
- `itlingo-cloud` — calls to `token_api/get-file-list` and `token_api/download-file`.
- `itoi-server` / `itoi-client` — user presence, file open/close, server-to-client messages.

Secrets (`DATABASE_URL` password, encrypted session tokens `iv`/`t`, `COM_KEY`, `COOKIE_KEY`) are never logged in plain text.

### Docker build args & runtime

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_VERSION` | `18.20.0` | Build-arg in the Dockerfile that selects the `node:<version>-alpine` base image for the IDE build stage. |
| `THEIA_WEBVIEW_EXTERNAL_ENDPOINT` | `{{hostname}}` | Set in the image; required by Theia to allow webview iframes from the runtime host. |
| `THEIA_DEFAULT_PLUGINS` | `local-dir:/home/theia/ide/plugins` | Where Theia loads the bundled VS Code extensions (currently `vscode-code-annotation`). |
| `NODE_OPTIONS` | `--max-old-space-size=4096` | Raises Node's heap to 4 GB so the Theia bundle build and Monaco/webpack tooling don't OOM. |
| `HOME` | `/home/theia` | Container `HOME`; some Theia caches and the `node-gyp` cache resolve under it. |
| `SHELL` | `/bin/sh` | Used by Theia's integrated terminal. |

### Archived language-server plugin debugging

The following variables are used only when manually developing the archived
`plugins/asl-langium` or `plugins/rsl-vscode-extension` sources. Those plugins
are no longer built into the ITOI image:

| Variable | Default | Description |
| --- | --- | --- |
| `DEBUG_BREAK` | (unset) | When truthy, the language server starts with `--inspect-brk` and waits for a debugger to attach before serving requests. |
| `DEBUG_SOCKET` | `6009` | Port the language server's inspector listens on. |
