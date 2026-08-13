import * as monaco from '@theia/monaco-editor-core';
import URI from '@theia/core/lib/common/uri';
import { Diagnostic } from '@theia/core/shared/vscode-languageserver-protocol';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';

/** Registration metadata served by dsl-lsp-service GET /dsls. */
export interface DslDescriptor {
    acronym: string;
    name: string;
    version: string;
    status: string;
    languageId: string;
    /** Without dot, e.g. ["psl"]. */
    extensions: string[];
    keywords: string[];
}

/** A workspace document to register with the language server at startup. */
export interface DslWorkspaceSpec {
    uri: string;
    text: string;
}

export type WorkspaceSpecCollector = () => Promise<readonly DslWorkspaceSpec[]>;

/** Keep workspace discovery and Monaco model matching on the same extension rules. */
export function matchesDslExtension(path: string, extensions: readonly string[]): boolean {
    const normalizedPath = path.toLowerCase();
    return extensions.some(extension => normalizedPath.endsWith(`.${extension.toLowerCase()}`));
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }

const log = {
    info: (msg: string, ...rest: unknown[]) => console.info(`[dsl-runtime] ${msg}`, ...rest),
    warn: (msg: string, ...rest: unknown[]) => console.warn(`[dsl-runtime] ${msg}`, ...rest),
    error: (msg: string, ...rest: unknown[]) => console.error(`[dsl-runtime] ${msg}`, ...rest),
};

/**
 * Minimal LSP client for one dynamic DSL, speaking JSON-RPC over a
 * WebSocket to the dsl-lsp-service. Deliberately hand-rolled: the
 * monaco-languageclient stack is not compatible with the monaco build
 * embedded in this Theia version, and the feature set we need
 * (diagnostics, completion, hover, definition, document sync) is small.
 */
export class DslLanguageClient {

    private webSocket: WebSocket | undefined;
    private nextRequestId = 1;
    private readonly pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    private readonly documentVersions = new Map<string, number>();
    /** Change subscriptions belong to Monaco models, not server documents. */
    private readonly modelSubscriptions = new Map<string, monaco.IDisposable>();
    /** Workspace documents remain open in the server when their editor model is disposed. */
    private readonly workspaceUris = new Set<string>();
    private readonly markerOwner: string;
    private readonly publishedMarkerUris = new Set<string>();
    private startPromise: Promise<void> | undefined;

    constructor(
        private readonly descriptor: DslDescriptor,
        private readonly webSocketUrl: string,
        private readonly problemManager: ProblemManager,
        private readonly collectWorkspaceSpecs: WorkspaceSpecCollector = async () => [],
    ) {
        this.markerOwner = `dsl-runtime-${descriptor.languageId}`;
    }

    /** Eager, no socket: providers + the watcher that triggers activation. */
    register(): void {
        this.registerProviders();
        this.watchModels();
    }

    /** Idempotent; opens the socket on first call. */
    ensureStarted(): Promise<void> {
        if (!this.startPromise) {
            this.startPromise = this.connect()
                .then(async () => {
                    await this.preloadWorkspaceSpecs();
                    // Backfill: models opened before the socket was ready.
                    // Preloaded workspace documents are registered first so an
                    // editor model for the same URI is not opened twice.
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

    // ------------------------------------------------------------------
    // JSON-RPC over WebSocket
    // ------------------------------------------------------------------

    private connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const webSocket = new WebSocket(this.webSocketUrl);
            this.webSocket = webSocket;
            webSocket.onopen = async () => {
                try {
                    await this.sendRequest('initialize', {
                        processId: null,
                        rootUri: null,
                        workspaceFolders: null,
                        capabilities: {
                            textDocument: {
                                publishDiagnostics: {},
                                completion: {
                                    completionItem: {
                                        snippetSupport: true,
                                        documentationFormat: ['markdown', 'plaintext'],
                                    },
                                },
                                hover: { contentFormat: ['markdown', 'plaintext'] },
                                definition: {},
                            },
                        },
                    });
                    this.sendNotification('initialized', {});
                    log.info(`language server ready: ${this.descriptor.acronym} ${this.descriptor.version} (${this.descriptor.status})`);
                    resolve();
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            };
            webSocket.onerror = () => reject(new Error(`WebSocket error connecting to ${this.webSocketUrl}`));
            webSocket.onclose = (event) => {
                log.warn(`connection closed for ${this.descriptor.acronym} (code ${event.code}); reload ITOI to reconnect`);
                this.clearAllMarkers();
            };
            webSocket.onmessage = (event) => this.handleMessage(String(event.data));
        });
    }

    private handleMessage(data: string): void {
        let message: any;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (message.id !== undefined && message.method === undefined) {
            // Response to one of our requests.
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                if (message.error) {
                    pending.reject(new Error(message.error.message ?? 'LSP request failed'));
                } else {
                    pending.resolve(message.result);
                }
            }
        } else if (message.id !== undefined && message.method !== undefined) {
            // Server-to-client request: we support none, answer null so the
            // server never hangs waiting for us.
            this.sendRaw({ jsonrpc: '2.0', id: message.id, result: null });
        } else if (message.method === 'textDocument/publishDiagnostics') {
            this.applyDiagnostics(message.params);
        }
        // Other notifications (logMessage, ...) are intentionally ignored.
    }

    private sendRaw(payload: object): void {
        if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
            this.webSocket.send(JSON.stringify(payload));
        }
    }

    private sendRequest(method: string, params: unknown): Promise<any> {
        const id = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.sendRaw({ jsonrpc: '2.0', id, method, params });
            setTimeout(() => {
                if (this.pendingRequests.delete(id)) {
                    reject(new Error(`timeout waiting for ${method}`));
                }
            }, 15000);
        });
    }

    private sendNotification(method: string, params: unknown): void {
        this.sendRaw({ jsonrpc: '2.0', method, params });
    }

    // ------------------------------------------------------------------
    // Document synchronization
    // ------------------------------------------------------------------

    private matchesLanguage(model: monaco.editor.ITextModel): boolean {
        if (model.getLanguageId() === this.descriptor.languageId) {
            return true;
        }
        return matchesDslExtension(model.uri.path, this.descriptor.extensions);
    }

    private async preloadWorkspaceSpecs(): Promise<void> {
        let specs: readonly DslWorkspaceSpec[];
        try {
            specs = await this.collectWorkspaceSpecs();
        } catch (error) {
            log.warn(`could not collect workspace specs for ${this.descriptor.acronym}`, error);
            return;
        }

        for (const spec of specs) {
            let resource: monaco.Uri;
            try {
                resource = monaco.Uri.parse(spec.uri);
            } catch (error) {
                log.warn(`ignoring workspace spec with an invalid URI: ${spec.uri}`, error);
                continue;
            }
            if (resource.scheme !== 'file' || !matchesDslExtension(resource.path, this.descriptor.extensions)) {
                continue;
            }

            const uri = resource.toString();
            this.workspaceUris.add(uri);
            if (this.documentVersions.has(uri)) {
                continue;
            }
            this.documentVersions.set(uri, 1);
            this.sendNotification('textDocument/didOpen', {
                textDocument: {
                    uri,
                    languageId: this.descriptor.languageId,
                    version: 1,
                    text: spec.text,
                },
            });
        }
    }

    private watchModels(): void {
        for (const model of monaco.editor.getModels()) {
            this.considerModel(model);
        }
        monaco.editor.onDidCreateModel(model => this.considerModel(model));
        monaco.editor.onWillDisposeModel(model => {
            const uri = model.uri.toString();
            this.modelSubscriptions.get(uri)?.dispose();
            this.modelSubscriptions.delete(uri);
            // A workspace preload is still needed to resolve references from
            // other files after the corresponding editor tab is closed.
            if (this.workspaceUris.has(uri)) {
                return;
            }
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

    private adoptModel(model: monaco.editor.ITextModel): void {
        if (model.uri.scheme !== 'file' || !this.matchesLanguage(model)) {
            return;
        }
        const uri = model.uri.toString();
        if (this.modelSubscriptions.has(uri)) {
            return;
        }
        if (model.getLanguageId() !== this.descriptor.languageId) {
            // Models created before our language registration (restored tabs).
            monaco.editor.setModelLanguage(model, this.descriptor.languageId);
        }
        if (this.documentVersions.has(uri)) {
            // The server already knows a preloaded document, or this is a
            // reopened editor tab. In either case, resync the current model
            // text without sending a duplicate didOpen.
            const version = (this.documentVersions.get(uri) ?? 1) + 1;
            this.documentVersions.set(uri, version);
            this.sendNotification('textDocument/didChange', {
                textDocument: { uri, version },
                contentChanges: [{ text: model.getValue() }],
            });
        } else {
            this.documentVersions.set(uri, 1);
            this.sendNotification('textDocument/didOpen', {
                textDocument: {
                    uri,
                    languageId: this.descriptor.languageId,
                    version: 1,
                    text: model.getValue(),
                },
            });
        }
        this.modelSubscriptions.set(uri, model.onDidChangeContent(() => {
            const version = (this.documentVersions.get(uri) ?? 1) + 1;
            this.documentVersions.set(uri, version);
            // A change event without range is a full-document sync, which
            // every LSP server (including Langium) accepts.
            this.sendNotification('textDocument/didChange', {
                textDocument: { uri, version },
                contentChanges: [{ text: model.getValue() }],
            });
        }));
    }

    // ------------------------------------------------------------------
    // Diagnostics
    // ------------------------------------------------------------------

    private applyDiagnostics(params: { uri: string; diagnostics: Diagnostic[] }): void {
        this.publishedMarkerUris.add(params.uri);
        this.problemManager.setMarkers(new URI(params.uri), this.markerOwner, params.diagnostics);
    }

    private clearAllMarkers(): void {
        for (const uri of this.publishedMarkerUris) {
            this.problemManager.setMarkers(new URI(uri), this.markerOwner, []);
        }
        this.publishedMarkerUris.clear();
    }

    // ------------------------------------------------------------------
    // Language feature providers
    // ------------------------------------------------------------------

    private toLspPosition(position: monaco.Position): LspPosition {
        return { line: position.lineNumber - 1, character: position.column - 1 };
    }

    private toMonacoRange(range: LspRange): monaco.IRange {
        return {
            startLineNumber: range.start.line + 1,
            startColumn: range.start.character + 1,
            endLineNumber: range.end.line + 1,
            endColumn: range.end.character + 1,
        };
    }

    private registerProviders(): void {
        const languageId = this.descriptor.languageId;

        monaco.languages.registerCompletionItemProvider(languageId, {
            triggerCharacters: ['.', ':', '"', "'"],
            provideCompletionItems: async (model, position) => {
                if (!this.documentVersions.has(model.uri.toString())) {
                    return { suggestions: [] };
                }
                try {
                    const result = await this.sendRequest('textDocument/completion', {
                        textDocument: { uri: model.uri.toString() },
                        position: this.toLspPosition(position),
                    });
                    const items: any[] = Array.isArray(result) ? result : result?.items ?? [];
                    const word = model.getWordUntilPosition(position);
                    const defaultRange: monaco.IRange = {
                        startLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endLineNumber: position.lineNumber,
                        endColumn: word.endColumn,
                    };
                    return {
                        suggestions: items.map(item => this.toMonacoCompletion(item, defaultRange)),
                    };
                } catch (error) {
                    log.warn('completion request failed', error);
                    return { suggestions: [] };
                }
            },
        });

        monaco.languages.registerHoverProvider(languageId, {
            provideHover: async (model, position) => {
                if (!this.documentVersions.has(model.uri.toString())) {
                    return undefined;
                }
                try {
                    const result = await this.sendRequest('textDocument/hover', {
                        textDocument: { uri: model.uri.toString() },
                        position: this.toLspPosition(position),
                    });
                    if (!result?.contents) {
                        return undefined;
                    }
                    return {
                        range: result.range ? this.toMonacoRange(result.range) : undefined,
                        contents: this.toHoverContents(result.contents),
                    };
                } catch (error) {
                    log.warn('hover request failed', error);
                    return undefined;
                }
            },
        });

        monaco.languages.registerDefinitionProvider(languageId, {
            provideDefinition: async (model, position) => {
                if (!this.documentVersions.has(model.uri.toString())) {
                    return undefined;
                }
                try {
                    const result = await this.sendRequest('textDocument/definition', {
                        textDocument: { uri: model.uri.toString() },
                        position: this.toLspPosition(position),
                    });
                    if (!result) {
                        return undefined;
                    }
                    const locations: any[] = Array.isArray(result) ? result : [result];
                    return locations.map(location => {
                        const uri = monaco.Uri.parse(
                            location.uri ?? location.targetUri,
                        );
                        return {
                            uri,
                            range: this.toMonacoRange(
                                location.range ?? location.targetSelectionRange,
                            ),
                        };
                    });
                } catch (error) {
                    log.warn('definition request failed', error);
                    return undefined;
                }
            },
        });
    }

    private toHoverContents(contents: any): monaco.IMarkdownString[] {
        const entries = Array.isArray(contents) ? contents : [contents];
        return entries.map(entry => {
            if (typeof entry === 'string') {
                return { value: entry };
            }
            if (entry?.value !== undefined) {
                return { value: String(entry.value) };
            }
            return { value: '' };
        }).filter(entry => entry.value.length > 0);
    }

    private toMonacoCompletion(item: any, defaultRange: monaco.IRange): monaco.languages.CompletionItem {
        let range = defaultRange;
        let insertText: string = item.insertText ?? item.label;
        if (item.textEdit?.range) {
            range = this.toMonacoRange(item.textEdit.range);
            insertText = item.textEdit.newText;
        }
        const completion: monaco.languages.CompletionItem = {
            label: item.label,
            kind: this.toMonacoCompletionKind(item.kind),
            insertText,
            range: range as any,
            detail: item.detail,
            documentation: typeof item.documentation === 'object'
                ? { value: String(item.documentation.value ?? '') }
                : item.documentation,
            sortText: item.sortText,
            filterText: item.filterText,
        };
        if (item.insertTextFormat === 2) {
            completion.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
        }
        return completion;
    }

    private toMonacoCompletionKind(lspKind: number | undefined): monaco.languages.CompletionItemKind {
        const kinds = monaco.languages.CompletionItemKind;
        switch (lspKind) {
            case 2: return kinds.Method;
            case 3: return kinds.Function;
            case 4: return kinds.Constructor;
            case 5: return kinds.Field;
            case 6: return kinds.Variable;
            case 7: return kinds.Class;
            case 8: return kinds.Interface;
            case 9: return kinds.Module;
            case 10: return kinds.Property;
            case 13: return kinds.Enum;
            case 14: return kinds.Keyword;
            case 15: return kinds.Snippet;
            case 17: return kinds.File;
            case 18: return kinds.Reference;
            case 19: return kinds.Folder;
            case 20: return kinds.EnumMember;
            case 21: return kinds.Constant;
            case 22: return kinds.Struct;
            case 25: return kinds.TypeParameter;
            default: return kinds.Text;
        }
    }
}
