import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Module } from 'langium';
import { createServicesForGrammar } from 'langium/grammar';
import { startLanguageServer } from 'langium/lsp';
import type { LangiumServices, LangiumSharedServices } from 'langium/lsp';
import { createConnection } from 'vscode-languageserver/node';
import type { MessageReader, MessageWriter } from 'vscode-languageserver/node';
import type { ResolvedDsl } from './registry.js';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeModulesDirectory = resolve(appDirectory, '.runtime-modules');
const materializedModules = new Map<string, Promise<string>>();

type DslServicesModule = Module<LangiumServices, unknown>;

function servicesCacheKey(dsl: ResolvedDsl): string {
    // Hash even a cloud-supplied digest so it can never escape the cache directory
    // or exceed filesystem filename limits. If an older cloud omits the digest,
    // the artifact itself remains a stable cache key.
    return createHash('sha256')
        .update(dsl.servicesDigest?.trim() || dsl.services || '')
        .digest('hex');
}

async function materializeServicesModule(dsl: ResolvedDsl): Promise<string> {
    const cacheKey = servicesCacheKey(dsl);
    const existing = materializedModules.get(cacheKey);
    if (existing) {
        return existing;
    }

    const materializing = (async () => {
        await mkdir(runtimeModulesDirectory, { recursive: true, mode: 0o700 });
        const modulePath = resolve(runtimeModulesDirectory, `${cacheKey}.mjs`);
        const temporaryPath = `${modulePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, dsl.services!, { encoding: 'utf8', mode: 0o600 });
        // Atomic replacement prevents another session from importing a partial file.
        await rename(temporaryPath, modulePath);
        return modulePath;
    })();
    materializedModules.set(cacheKey, materializing);
    try {
        return await materializing;
    } catch (error) {
        materializedModules.delete(cacheKey);
        throw error;
    }
}

async function loadServicesModule(dsl: ResolvedDsl): Promise<DslServicesModule> {
    const modulePath = await materializeServicesModule(dsl);
    const imported = await import(pathToFileURL(modulePath).href) as { default?: unknown };
    const exported = typeof imported.default === 'function'
        ? (imported.default as () => unknown)()
        : imported.default;
    if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) {
        throw new TypeError('The services module default export must be a module object or factory');
    }
    return exported as DslServicesModule;
}

function grammarConfig(
    dsl: ResolvedDsl,
    sharedModule?: Module<LangiumSharedServices, unknown>,
    module?: DslServicesModule,
) {
    return {
        grammar: dsl.grammar,
        languageMetaData: {
            languageId: dsl.languageId,
            fileExtensions: dsl.extensions.map((ext) => `.${ext}`),
            caseInsensitive: false,
            mode: 'production' as const,
        },
        module,
        sharedModule,
    };
}

/** Build a DSL's services, falling back to Langium defaults for a broken author module. */
export async function createDslServices(
    dsl: ResolvedDsl,
    sharedModule?: Module<LangiumSharedServices, unknown>,
): Promise<LangiumServices> {
    if (dsl.services) {
        try {
            const module = await loadServicesModule(dsl);
            return await createServicesForGrammar(grammarConfig(dsl, sharedModule, module));
        } catch (error) {
            console.error(
                `[dsl-services] Failed to load services for ${dsl.acronym} ${dsl.version} `
                + `(${dsl.status}); falling back to Langium defaults:`,
                error,
            );
        }
    }
    return createServicesForGrammar(grammarConfig(dsl, sharedModule));
}

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
    const services = await createDslServices(dsl, {
        // Injected last, so it overrides the default (absent) connection and
        // turns the grammar services into a fully wired language server.
        lsp: {
            Connection: () => connection,
        },
    } as any);
    startLanguageServer(services.shared);
}
