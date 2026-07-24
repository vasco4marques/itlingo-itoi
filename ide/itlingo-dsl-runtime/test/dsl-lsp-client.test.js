const assert = require('node:assert/strict');
const Module = require('node:module');

const models = [];
let didCreateModel;
let willDisposeModel;

function uri(value) {
    const parsed = new URL(value);
    return {
        scheme: parsed.protocol.slice(0, -1),
        path: parsed.pathname,
        toString: () => value,
    };
}

const monaco = {
    Uri: { parse: uri },
    editor: {
        getModels: () => models,
        onDidCreateModel: listener => {
            didCreateModel = listener;
            return { dispose() {} };
        },
        onWillDisposeModel: listener => {
            willDisposeModel = listener;
            return { dispose() {} };
        },
        setModelLanguage(model, languageId) {
            model.languageId = languageId;
        },
        setModelMarkers() {},
    },
    languages: {},
    MarkerSeverity: {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@theia/monaco-editor-core') {
        return monaco;
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { DslLanguageClient } = require('../lib/browser/dsl-lsp-client.js');
Module._load = originalLoad;

function createModel(value) {
    let onChange;
    return {
        uri: uri('file:///workspace/provider.spec'),
        languageId: 'plaintext',
        getLanguageId() { return this.languageId; },
        getValue: () => value,
        onDidChangeContent(listener) {
            onChange = listener;
            return { dispose() { onChange = undefined; } };
        },
        change(nextValue) {
            value = nextValue;
            onChange();
        },
    };
}

async function main() {
    const sent = [];
    global.WebSocket = { OPEN: 1 };
    const client = new DslLanguageClient(
        {
            acronym: 'SPEC',
            name: 'Spec',
            version: '1.0',
            status: 'active',
            languageId: 'itlingo-spec',
            extensions: ['spec'],
            keywords: [],
        },
        'ws://unused',
        async () => [{ uri: 'file:///workspace/provider.spec', text: 'entity Provider' }],
    );
    client.webSocket = {
        readyState: 1,
        send(payload) { sent.push(JSON.parse(payload)); },
    };
    client.startPromise = Promise.resolve();
    client.watchModels();

    await client.preloadWorkspaceSpecs();
    assert.equal(
        sent.filter(message => message.method === 'textDocument/didOpen').length,
        1,
        'workspace preload opens the provider exactly once',
    );

    const model = createModel('entity Provider');
    models.push(model);
    didCreateModel(model);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        sent.filter(message => message.method === 'textDocument/didOpen').length,
        1,
        'opening the preloaded workspace file in Monaco does not send a second didOpen',
    );

    const changesBeforeEdit = sent.filter(message => message.method === 'textDocument/didChange').length;
    model.change('entity RenamedProvider');
    assert.equal(
        sent.filter(message => message.method === 'textDocument/didChange').length,
        changesBeforeEdit + 1,
        'the editor model takes over the preload and keeps subsequent edits synchronized',
    );

    willDisposeModel(model);
    assert.equal(
        sent.filter(message => message.method === 'textDocument/didClose').length,
        0,
        'disposing a Monaco model does not close a document that remains preloaded from the workspace',
    );

    const reopenedModel = createModel('entity RenamedProvider');
    models.splice(models.indexOf(model), 1, reopenedModel);
    didCreateModel(reopenedModel);
    await new Promise(resolve => setImmediate(resolve));
    const changesBeforeReopenEdit = sent.filter(message => message.method === 'textDocument/didChange').length;
    reopenedModel.change('entity ProviderAfterReopen');
    assert.equal(
        sent.filter(message => message.method === 'textDocument/didChange').length,
        changesBeforeReopenEdit + 1,
        'reopening a preloaded file attaches a fresh content-change subscription',
    );

    console.log('DSL LANGUAGE CLIENT TEST PASSED');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
