import { createServicesForGrammar } from 'langium/grammar';
import { startLanguageServer } from 'langium/lsp';
import { createConnection } from 'vscode-languageserver/node';
import type { MessageReader, MessageWriter } from 'vscode-languageserver/node';
import type { ResolvedDsl } from './registry.js';

/**
 * Serve one LSP session for one DSL over the given message reader/writer
 * (backed by a WebSocket). Every session gets its own Langium services
 * instance because document state and the LSP connection are per client;
 * building services from a grammar string takes only a few milliseconds.
 */
export async function serveLspSession(
    reader: MessageReader,
    writer: MessageWriter,
    dsl: ResolvedDsl,
): Promise<void> {
    const connection = createConnection(reader, writer);
    const services = await createServicesForGrammar({
        grammar: dsl.grammar,
        languageMetaData: {
            languageId: dsl.languageId,
            fileExtensions: dsl.extensions.map((ext) => `.${ext}`),
            caseInsensitive: false,
            mode: 'production',
        },
        // Injected last, so it overrides the default (absent) connection and
        // turns the grammar services into a fully wired language server.
        sharedModule: {
            lsp: {
                Connection: () => connection,
            },
        } as any,
    });
    startLanguageServer(services.shared);
}
