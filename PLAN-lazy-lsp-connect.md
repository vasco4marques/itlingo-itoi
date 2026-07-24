# Plan: connect DSL language clients lazily

Status: **not started**. Written 2026-07-17. Self-contained — read this file plus the
two source files it names and you have everything you need.

## Why

`dsl-lsp-service` builds a full Langium service graph **per WebSocket connection**
(`dsl-lsp-service/src/lsp.ts` → `createServicesForGrammar`). Each graph carries its own
interpreted Chevrotain parser, AST reflection, validation registry and document store —
megabytes each, held for the life of the connection.

The ITOI frontend currently opens one connection **per DSL per user, eagerly at startup**,
whether or not the user ever opens a file of that type. With 10 DSLs and 1000 concurrent
users that is 10,000 sockets and — the part that actually hurts — 10,000 Langium graphs.

A user realistically edits one DSL, occasionally two. Connecting only when a document of
that language is actually opened takes ~10 sessions per user down to ~1, without changing
any protocol or any server code. Past that point the sidecar scales horizontally (see
"Out of scope").

## Scope

**Client only.** Every change is in `ide/itlingo-dsl-runtime/src/browser/`. The server is
already per-connection and per-language; it needs no change. Do not touch
`dsl-lsp-service/`.

## Current behaviour

`dsl-runtime-contribution.ts`:
- L74-79 — `setup()` loops every descriptor from `/dsls` and awaits `registerDsl` for each.
- L83-105 — `registerDsl()` filters already-claimed extensions, calls
  `monaco.languages.register` + `registerHighlighting(dsl)`, then constructs a
  `DslLanguageClient` and **awaits `client.start()`** (L104). This is the eager connect.

`dsl-lsp-client.ts`:
- L47-51 — `start()` does `connect()` → `registerProviders()` → `trackModels()`, in that
  order. Nothing works until the socket is open.
- L160-171 — `trackModels()` adopts existing models, then subscribes to
  `onDidCreateModel` / `onWillDisposeModel`.
- L173+ — `adoptModel()` sends `textDocument/didOpen` and wires `onDidChangeContent`.
  Already guards on `documentVersions.has(uri)`, so it is idempotent.

## Target behaviour

Split registration (eager, free, client-side only) from activation (lazy, opens the socket):

- **Eager, at startup, for every DSL:** `monaco.languages.register`, `registerHighlighting`,
  `registerProviders`, and a model watcher. No socket. This is safe and cheap —
  `GET /dsls` already returns `keywords` with the grammar text stripped
  (`toClientDescriptor` in `dsl-lsp-service/src/registry.ts`), so syntax highlighting needs
  no server session at all.
- **Lazy, on first matching model:** open the WebSocket, `initialize`, then backfill
  `didOpen` for every already-open matching model.

## Changes

### 1. `dsl-lsp-client.ts` — split `start()` into `register()` + `ensureStarted()`

Replace `start()` (L47-51) with:

```ts
/** Eager, no socket: providers + the watcher that triggers activation. */
register(): void {
    this.registerProviders();
    this.watchModels();
}

/** Idempotent; opens the socket on first call. */
ensureStarted(): Promise<void> {
    if (!this.startPromise) {
        this.startPromise = this.connect()
            .then(() => {
                // Backfill: models opened before the socket was ready.
                for (const model of monaco.editor.getModels()) {
                    this.adoptModel(model);
                }
            })
            .catch(error => {
                // Do not cache the failure — let a later model-open retry.
                this.startPromise = undefined;
                throw error;
            });
    }
    return this.startPromise;
}
```

with `private startPromise: Promise<void> | undefined;` alongside the other fields.

Rework `trackModels()` (L160-171) into `watchModels()`, which subscribes eagerly and uses a
matching model as the activation trigger:

```ts
private watchModels(): void {
    for (const model of monaco.editor.getModels()) {
        this.considerModel(model);
    }
    monaco.editor.onDidCreateModel(model => this.considerModel(model));
    monaco.editor.onWillDisposeModel(model => {
        const uri = model.uri.toString();
        if (this.documentVersions.delete(uri)) {
            this.sendNotification('textDocument/didClose', { textDocument: { uri } });
        }
    });
}

private considerModel(model: monaco.editor.ITextModel): void {
    if (model.uri.scheme !== 'file' || !this.matchesLanguage(model)) {
        return;
    }
    this.ensureStarted()
        .then(() => this.adoptModel(model))
        .catch(error => log.warn(`could not start ${this.descriptor.acronym}`, error));
}
```

`onWillDisposeModel` is safe to subscribe eagerly: `sendRaw` (L119) already no-ops unless
the socket is `OPEN`.

Leave `adoptModel` as-is. It is already guarded, so the backfill loop and `considerModel`
can both reach the same model without sending a duplicate `didOpen`.

In the three providers (guards at L264, L292, L316), keep the existing
`documentVersions.has(...)` early-return. Do **not** add `await this.ensureStarted()` there —
`considerModel` has already fired for any model the user can interact with, and awaiting in
the provider would make a dead server hang every keystroke.

### 2. `dsl-runtime-contribution.ts` — stop awaiting the connect

At L103-105, construct the client and call `register()` instead of `await client.start()`:

```ts
const client = new DslLanguageClient({ ...dsl, extensions }, webSocketUrl);
client.register();
log.info(`registered DSL ${dsl.acronym} ${dsl.version} (${dsl.status}) for .${extensions.join(', .')}`);
```

Keep a reference to each client (e.g. push to a `protected readonly clients: DslLanguageClient[]`)
so they are not garbage-collected and so a future dispose has something to hold.

`registerDsl` no longer needs to be `async`; the `setup()` loop at L74-79 can drop its
`await`. Keep the per-DSL try/catch — a bad descriptor should still not take down the others.

Note the log line moves meaning: it now says "registered", not "connected". A DSL being
registered no longer implies a live server. The existing "language server ready" log in
`connect()` (L79) is what signals a real session.

## Edge cases

- **Restored tabs.** `adoptModel` calls `setModelLanguage` for models created before our
  language registration. Those models exist before `register()` runs, so the
  `getModels()` scan in `watchModels()` must run — do not drop it in favour of only
  subscribing to `onDidCreateModel`.
- **Failed connect.** Clearing `startPromise` in the `.catch` is deliberate: the socket is
  now opened from a user action, so a transient failure must not permanently disable the
  DSL. It retries on the next matching model open, not on a timer.
- **Server down entirely.** Highlighting must still work — that is the main visible win of
  registering eagerly. Verify this explicitly (see below).
- **`onclose`** (L89-92) currently logs "reload ITOI to reconnect" and clears markers.
  Leave it. Resetting `startPromise` there to allow reconnect-on-next-open is a tempting
  follow-up but is a behaviour change beyond this plan.

## Verification

The change is frontend-only, so tests in `dsl-lsp-service/test/` will not cover it. Verify
in the running app:

1. Build the IDE and launch ITOI with the sidecar up (see `DEPLOYMENT.md` /
   `docker-compose.yml`).
2. Open devtools → **Network → WS**, with no editor tabs open. **Expect zero
   `/lsp/...` connections.** This is the whole point of the change; today you see one per DSL.
3. Open a file for one DSL. Expect exactly **one** WS connection, for that languageId only,
   and `[dsl-runtime] language server ready: ...` in the console. Confirm diagnostics,
   completion and hover all still work.
4. Open a file for a second DSL. Expect a second connection, and the first still live.
5. Reload with a DSL tab already open (restored tab) — confirm it still connects and
   highlights, exercising the `getModels()` scan path.
6. Stop the sidecar, reload, open a DSL file. Expect syntax highlighting to still work and a
   single logged warning — no crash, no hang while typing.

## Out of scope — do not do these

- **Transport multiplexing** (one socket per user with a channel envelope). Rejected: costs a
  custom protocol on both sides and does not reduce the Langium graphs, which are the
  actual memory cost.
- **One shared Langium container per session with N languages registered into its
  `ServiceRegistry`.** This is the real constant-factor fix and gets the single socket for
  free, but `AstReflection` is a *shared* service, so it needs a composite across all
  grammars — and two DSLs declaring the same type name (e.g. both an RSL and an ASL `Model`)
  collide silently and corrupt cross-reference resolution rather than erroring. Not worth the
  correctness risk preemptively. Revisit only if per-user memory is measured as the real wall.
- **Horizontal scaling** is the answer past this change and needs no code: the sidecar holds
  no cross-user state (the only shared state is the per-token TTL cache in
  `dsl-lsp-service/src/cloud.ts`), and WebSockets are inherently sticky to one backend. Run
  more replicas.
