// End-to-end smoke test for the DSL LSP service.
//
// Starts a mock ITLingoCloud serving active and draft PSL grammars, spawns the sidecar
// against it, then drives a real LSP session over WebSocket:
//   1. GET /dsls returns the PSL registration (with keywords).
//   2. initialize / initialized handshake succeeds.
//   3. didOpen with a syntax error produces an error diagnostic.
//   4. didChange with valid content clears the diagnostics.
//
// Usage: node test/smoke.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const MOCK_CLOUD_PORT = 18069;
const SERVICE_PORT = 13001;

const ACTIVE_GRAMMAR = `grammar Psl

entry Model:
    elements+=Element*;

Element:
    'activeElement' name=ID;

terminal ID: /[_a-zA-Z][\\w_]*/;
hidden terminal WS: /\\s+/;
hidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;
`;

const DRAFT_GRAMMAR = `grammar Psl

entry Model:
    elements+=Element*;

Element:
    'element' name=ID;

terminal ID: /[_a-zA-Z][\\w_]*/;
hidden terminal WS: /\\s+/;
hidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;
`;

function fail(message) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
}

// --- 1. Mock ITLingoCloud -------------------------------------------------
const mockCloud = http.createServer((req, res) => {
    if (req.url === '/token_api/get-dsls') {
        if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
            res.writeHead(401).end(JSON.stringify({ error: 'no token' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            dsls: [
                {
                    acronym: 'PSL',
                    name: 'Project Specification Language',
                    version: '1.0',
                    status: 'active',
                    file_extensions: ['psl'],
                    grammar: ACTIVE_GRAMMAR,
                    digest: 'testdigest0001',
                },
                {
                    acronym: 'PSL',
                    name: 'Project Specification Language',
                    version: '1.1',
                    status: 'draft',
                    file_extensions: ['psl'],
                    grammar: DRAFT_GRAMMAR,
                    digest: 'testdigest0002',
                },
            ],
        }));
        return;
    }
    res.writeHead(404).end();
});
await new Promise((resolve) => mockCloud.listen(MOCK_CLOUD_PORT, resolve));

// --- 2. Spawn the sidecar ---------------------------------------------------
const service = spawn('node', ['dist/server.js'], {
    env: {
        ...process.env,
        PORT: String(SERVICE_PORT),
        ITLINGO_CLOUD_URL: `http://localhost:${MOCK_CLOUD_PORT}/`,
        RESERVED_EXTENSIONS: 'rsl,asl',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
});
process.on('exit', () => service.kill());

// Wait for /health
for (let attempt = 0; ; attempt++) {
    try {
        const response = await fetch(`http://localhost:${SERVICE_PORT}/health`);
        if (response.ok) break;
    } catch { /* not up yet */ }
    if (attempt > 50) fail('service did not become healthy');
    await new Promise((resolve) => setTimeout(resolve, 100));
}

// --- 3. Registration metadata ----------------------------------------------
const dslsResponse = await fetch(`http://localhost:${SERVICE_PORT}/dsls?iv=x&t=y`);
if (!dslsResponse.ok) fail(`/dsls returned HTTP ${dslsResponse.status}`);
const { dsls } = await dslsResponse.json();
if (dsls.length !== 2 || dsls.some((dsl) => dsl.acronym !== 'PSL')) fail('unexpected /dsls payload');
const activeDsl = dsls.find((dsl) => dsl.languageId === 'itlingo-psl');
const draftDsl = dsls.find((dsl) => dsl.languageId === 'itlingo-psl-draft');
if (!activeDsl || !draftDsl) fail('active and draft descriptors were not both returned');
if (!activeDsl.extensions.includes('psl')) fail('active psl extension missing');
if (!draftDsl.extensions.includes('psl-draft')) fail('draft psl-draft extension missing');
if (!draftDsl.keywords.includes('element')) fail('keyword extraction missed "element"');
console.log('OK  /dsls registration metadata');

// --- 4. LSP session ----------------------------------------------------------
const ws = new WebSocket(`ws://localhost:${SERVICE_PORT}/lsp/${draftDsl.languageId}?iv=x&t=y`);
await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
});

let nextId = 1;
const pendingResponses = new Map();
const diagnosticsEvents = [];
let diagnosticsWaiter = null;

ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.id !== undefined && pendingResponses.has(message.id)) {
        pendingResponses.get(message.id)(message);
        pendingResponses.delete(message.id);
    } else if (message.method === 'textDocument/publishDiagnostics') {
        diagnosticsEvents.push(message.params);
        if (diagnosticsWaiter) {
            const waiter = diagnosticsWaiter;
            diagnosticsWaiter = null;
            waiter(message.params);
        }
    }
});

function sendRequest(method, params) {
    const id = nextId++;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
        pendingResponses.set(id, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    });
}

function sendNotification(method, params) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function waitForDiagnostics() {
    return new Promise((resolve, reject) => {
        diagnosticsWaiter = resolve;
        setTimeout(() => reject(new Error('timeout waiting for diagnostics')), 10000);
    });
}

const initResult = await sendRequest('initialize', {
    processId: null,
    rootUri: null,
    workspaceFolders: null,
    capabilities: {},
});
if (!initResult.result?.capabilities) fail('initialize returned no capabilities');
sendNotification('initialized', {});
console.log('OK  initialize handshake');

const uri = 'file:///workspace/test.psl';
let diagnosticsPromise = waitForDiagnostics();
sendNotification('textDocument/didOpen', {
    textDocument: {
        uri,
        languageId: draftDsl.languageId,
        version: 1,
        text: 'element 123', // number where an identifier is required
    },
});
let diagnostics = await diagnosticsPromise;
if (!diagnostics.diagnostics.some((d) => d.severity === 1)) {
    fail(`expected an error diagnostic, got: ${JSON.stringify(diagnostics.diagnostics)}`);
}
console.log(`OK  invalid document produced ${diagnostics.diagnostics.length} diagnostic(s)`);

diagnosticsPromise = waitForDiagnostics();
sendNotification('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: 'element valid_name // fixed' }],
});
diagnostics = await diagnosticsPromise;
if (diagnostics.diagnostics.length !== 0) {
    fail(`expected clean diagnostics, got: ${JSON.stringify(diagnostics.diagnostics)}`);
}
console.log('OK  valid document cleared diagnostics');

ws.close();
mockCloud.close();
service.kill();
console.log('SMOKE TEST PASSED');
process.exit(0);
