// End-to-end smoke test for the DSL LSP service.
//
// Starts a mock ITLingoCloud serving active and draft PSL grammars, spawns the sidecar
// against it, then drives a real LSP session over WebSocket:
//   1. GET /dsls returns the PSL registration (with keywords).
//   2. initialize / initialized handshake succeeds.
//   3. didOpen with a syntax error produces an error diagnostic.
//   4. didChange with valid content clears the diagnostics.
//   5. The retired cloud-source endpoint is absent and LSP sessions do not
//      request a cloud corpus.
//
// Usage: node test/smoke.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const MOCK_CLOUD_PORT = 18069;
const SERVICE_PORT = 13001;
let cloudSourceRequests = 0;

const ACTIVE_GRAMMAR = `grammar Psl

entry Model:
    packages+=PackageSystem*;

PackageSystem:
    'Package' name=QualifiedName imports+=Import* system=System;

Import:
    'Import' importedNamespace=QualifiedNameWithWildcard;

System:
    'System' name=ID concepts+=(Entity | Derived)*;

Entity:
    'Entity' name=ID '{' attributes+=Attribute* '}';

Attribute:
    'attribute' name=ID;

Derived:
    'derived' from=[Attribute:QualifiedName];

QualifiedName returns string:
    ID ('.' ID)*;

QualifiedNameWithWildcard returns string:
    QualifiedName '.*'?;

terminal ID: /[_a-zA-Z][\\w_]*/;
hidden terminal WS: /\\s+/;
hidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;
`;

const IMPORT_SCOPE_SERVICES = `
import {
    AstUtils, DefaultNameProvider, DefaultScopeComputation,
    DefaultScopeProvider, EMPTY_SCOPE, interruptAndCheck, isNamed, stream,
    StreamScope,
} from 'langium';
const { getContainerOfType, getDocument, streamAllContents } = AstUtils;
class Names extends DefaultNameProvider {
    getQualifiedName(node) {
        if (!node.$container) return '';
        const parent = this.getQualifiedName(node.$container);
        const name = this.getName(node);
        return name ? (parent ? parent + '.' + name : name) : parent;
    }
}
class Exports extends DefaultScopeComputation {
    async collectExportedSymbols(document, token) {
        const out = [];
        for (const node of streamAllContents(document.parseResult.value)) {
            if (token) await interruptAndCheck(token);
            if (!isNamed(node)) continue;
            const name = this.nameProvider.getQualifiedName(node);
            if (name) out.push(this.descriptions.createDescription(node, name, document));
        }
        return out;
    }
}
function matches(imp, name) {
    const left = String(imp.importedNamespace).split('.');
    const right = name.split('.');
    return left.every((part, index) => part === '*' || part === right[index]);
}
function normalized(imp, name) {
    const parts = String(imp.importedNamespace).split('.');
    if (parts.at(-1) === '*') parts.pop();
    return name.replace(parts.join('.') + '.', '');
}
class Scopes extends DefaultScopeProvider {
    getGlobalScope(type, context) {
        const system = getContainerOfType(context.container, node => node.$type === 'System');
        const pkg = getContainerOfType(context.container, node => node.$type === 'PackageSystem');
        if (!pkg) return EMPTY_SCOPE;
        const contextUri = getDocument(context.container).uri.toString();
        const prefix = system ? this.nameProvider.getQualifiedName(system) : '';
        const elements = this.indexManager.allElements(type).map(description => {
            const imp = pkg.imports.find(item => matches(item, description.name));
            let name = imp ? normalized(imp, description.name) : description.name;
            const targetSystem = getContainerOfType(
                description.node, node => node.$type === 'System'
            );
            if (imp && targetSystem) {
                const systemName = normalized(
                    imp, this.nameProvider.getQualifiedName(targetSystem)
                );
                if (systemName && name.startsWith(systemName + '.')) {
                    name = name.slice(systemName.length + 1);
                }
            }
            if (
                !imp
                && description.documentUri.toString() === contextUri
                && prefix
                && name.startsWith(prefix + '.')
            ) {
                name = name.slice(prefix.length + 1);
            } else if (!imp) {
                return undefined;
            }
            return { ...description, name };
        }).filter(Boolean).toArray();
        return elements.length ? new StreamScope(stream(elements)) : EMPTY_SCOPE;
    }
}
export default () => ({ references: {
    NameProvider: () => new Names(),
    ScopeComputation: services => new Exports(services),
    ScopeProvider: services => new Scopes(services),
}});
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
                    id: 1,
                    acronym: 'PSL',
                    name: 'Project Specification Language',
                    version: '1.0',
                    status: 'active',
                    file_extensions: ['psl'],
                    grammar: ACTIVE_GRAMMAR,
                    digest: 'testdigest0001',
                    services: IMPORT_SCOPE_SERVICES,
                    services_digest: 'import-scope-services-v1',
                },
                {
                    id: 2,
                    acronym: 'PSL',
                    name: 'Project Specification Language',
                    version: '1.1',
                    status: 'draft',
                    file_extensions: ['psl'],
                    grammar: DRAFT_GRAMMAR,
                    digest: 'testdigest0002',
                    services: 'export default () => { throw new Error("smoke load failure"); };',
                    services_digest: 'broken-services-smoke-v1',
                },
            ],
        }));
        return;
    }
    if (req.url?.startsWith('/token_api/get-dsl-sources/')) {
        cloudSourceRequests++;
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'retired endpoint' }));
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
        RESERVED_EXTENSIONS: '',
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

const retiredSourceEndpoint = await fetch(
    `http://localhost:${SERVICE_PORT}/dsl-sources/${activeDsl.languageId}/101?iv=x&t=y`,
);
if (retiredSourceEndpoint.status !== 404) {
    fail(`retired /dsl-sources endpoint returned HTTP ${retiredSourceEndpoint.status}`);
}
console.log('OK  retired /dsl-sources endpoint is absent');

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
const showMessageEvents = [];
let showMessageWaiter = null;

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
    } else if (message.method === 'window/showMessage') {
        showMessageEvents.push(message.params);
        if (showMessageWaiter) {
            const waiter = showMessageWaiter;
            showMessageWaiter = null;
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

function waitForShowMessage() {
    return new Promise((resolve, reject) => {
        if (showMessageEvents.length) {
            resolve(showMessageEvents.at(-1));
            return;
        }
        showMessageWaiter = resolve;
        setTimeout(() => reject(new Error('timeout waiting for window/showMessage')), 10000);
    });
}

const initResult = await sendRequest('initialize', {
    processId: null,
    rootUri: null,
    workspaceFolders: null,
    capabilities: {},
});
if (!initResult.result?.capabilities) fail('initialize returned no capabilities');
await new Promise((resolve) => setImmediate(resolve));
if (showMessageEvents.length) {
    fail('services fallback error was delivered before the initialized notification');
}
const showMessagePromise = waitForShowMessage();
sendNotification('initialized', {});
const showMessage = await showMessagePromise;
if (showMessage.type !== 1 || !showMessage.message.includes('smoke load failure')) {
    fail(`expected services load error toast, got: ${JSON.stringify(showMessage)}`);
}
console.log('OK  initialize handshake');
console.log('OK  services fallback error delivered after initialize');

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

// --- 5. Active LSP sessions do not fetch a cloud corpus ---------------------
const importWs = new WebSocket(
    `ws://localhost:${SERVICE_PORT}/lsp/${activeDsl.languageId}?iv=x&t=y`,
);
await new Promise((resolve, reject) => {
    importWs.on('open', resolve);
    importWs.on('error', reject);
});
const importPending = new Map();
let importNextId = 100;
importWs.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.id !== undefined && importPending.has(message.id)) {
        importPending.get(message.id)(message);
        importPending.delete(message.id);
    }
});
function importRequest(method, params) {
    const id = importNextId++;
    importWs.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
        importPending.set(id, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    });
}
function importNotify(method, params) {
    importWs.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}
await importRequest('initialize', {
    processId: null,
    rootUri: null,
    workspaceFolders: null,
    capabilities: {},
});
importNotify('initialized', {});
await new Promise(resolve => setTimeout(resolve, 100));
if (cloudSourceRequests !== 0) {
    fail(`LSP session requested the retired cloud corpus ${cloudSourceRequests} time(s)`);
}
console.log('OK  LSP session does not request a cloud corpus');

ws.close();
importWs.close();
mockCloud.close();
service.kill();
console.log('SMOKE TEST PASSED');
process.exit(0);
