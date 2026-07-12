import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';
import { config } from './config.js';
import { getRegistry, toClientDescriptor } from './registry.js';
import { serveLspSession } from './lsp.js';
const app = express();
app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'dsl-lsp-service', timestamp: new Date().toISOString() });
});
// Registration metadata for the ITOI frontend. Requires the ITOI launch
// token (iv + t) which is forwarded to ITLingoCloud for authorization.
app.get('/dsls', async (req, res) => {
    const iv = String(req.query.iv ?? '');
    const t = String(req.query.t ?? '');
    if (!iv || !t) {
        return res.status(401).json({ error: 'Missing iv/t launch token' });
    }
    try {
        const registry = await getRegistry(iv, t);
        res.json({ dsls: registry.map(toClientDescriptor) });
    }
    catch (error) {
        console.error('Failed to build DSL registry:', error);
        res.status(502).json({ error: String(error) });
    }
});
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    if (!/^\/lsp\/[^/]+$/.test(url.pathname)) {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, request);
    });
});
wss.on('connection', (webSocket, request) => {
    // Reader/writer are created synchronously so no early client message
    // (e.g. `initialize`) is lost while the services are being built.
    const socket = toSocket(webSocket);
    const reader = new WebSocketMessageReader(socket);
    const writer = new WebSocketMessageWriter(socket);
    void (async () => {
        const url = new URL(request.url ?? '', 'http://localhost');
        const languageId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const iv = url.searchParams.get('iv') ?? '';
        const t = url.searchParams.get('t') ?? '';
        if (!iv || !t) {
            webSocket.close(4401, 'Missing iv/t launch token');
            return;
        }
        try {
            const registry = await getRegistry(iv, t);
            const dsl = registry.find((entry) => entry.languageId.toLowerCase() === languageId.toLowerCase());
            if (!dsl) {
                webSocket.close(4404, `Unknown language: ${languageId}`);
                return;
            }
            console.log(`LSP session started: dsl=${dsl.acronym} ${dsl.version} (${dsl.status}) digest=${dsl.digest.slice(0, 12)}`);
            await serveLspSession(reader, writer, dsl);
        }
        catch (error) {
            console.error(`Failed to start LSP session for '${languageId}':`, error);
            webSocket.close(1011, 'Failed to start language server');
        }
    })();
});
server.listen(config.port, () => {
    console.log(`DSL LSP service listening on http://localhost:${config.port}`);
    console.log(`  ITLingoCloud URL:    ${config.itlingoCloudUrl}`);
    console.log(`  Reserved extensions: ${config.reservedExtensions.join(', ') || '(none)'}`);
    console.log('  Endpoints: GET /health, GET /dsls?iv=..&t=.., WS /lsp/<languageId>?iv=..&t=..');
});
