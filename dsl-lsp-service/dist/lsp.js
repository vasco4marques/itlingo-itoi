import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EmptyFileSystem, URI, } from 'langium';
import { collectAst, collectTypeHierarchy, createLangiumGrammarServices, createServicesForGrammar, mergeTypesAndInterfaces, } from 'langium/grammar';
import { startLanguageServer } from 'langium/lsp';
import { createConnection, MessageType, ShowMessageNotification, } from 'vscode-languageserver/node';
import { config } from './config.js';
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeModulesDirectory = resolve(appDirectory, '.runtime-modules');
const materializedModules = new Map();
async function withTimeout(operation, timeoutMs, description) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${description} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
    });
    try {
        return await Promise.race([operation, timeout]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
function servicesCacheKey(dsl) {
    // Hash even a cloud-supplied digest so it can never escape the cache directory
    // or exceed filesystem filename limits. If an older cloud omits the digest,
    // the artifact itself remains a stable cache key.
    return createHash('sha256')
        .update(dsl.servicesDigest?.trim() || dsl.services || '')
        .digest('hex');
}
async function materializeServicesModule(dsl) {
    const cacheKey = servicesCacheKey(dsl);
    const existing = materializedModules.get(cacheKey);
    if (existing) {
        return existing;
    }
    const materializing = (async () => {
        await mkdir(runtimeModulesDirectory, { recursive: true, mode: 0o700 });
        const modulePath = resolve(runtimeModulesDirectory, `${cacheKey}.mjs`);
        const temporaryPath = `${modulePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, dsl.services, { encoding: 'utf8', mode: 0o600 });
        // Atomic replacement prevents another session from importing a partial file.
        await rename(temporaryPath, modulePath);
        return modulePath;
    })();
    materializedModules.set(cacheKey, materializing);
    try {
        return await materializing;
    }
    catch (error) {
        materializedModules.delete(cacheKey);
        throw error;
    }
}
async function loadServicesModule(dsl) {
    const modulePath = await materializeServicesModule(dsl);
    const imported = await import(pathToFileURL(modulePath).href);
    const exported = typeof imported.default === 'function'
        ? imported.default()
        : imported.default;
    if (typeof exported !== 'object'
        || exported === null
        || Array.isArray(exported)
        || typeof exported.then === 'function') {
        throw new TypeError('The services module default export must be a synchronous module object or factory');
    }
    return exported;
}
function grammarConfig(dsl, parsedGrammar, sharedModule, module) {
    return {
        grammar: parsedGrammar.grammarNode,
        grammarServices: parsedGrammar.grammarServices,
        languageMetaData: {
            languageId: dsl.languageId,
            fileExtensions: dsl.extensions.map((ext) => `.${ext}`),
            caseInsensitive: false,
            mode: 'production',
        },
        module,
        sharedModule,
    };
}
/**
 * Langium 4.3.1's interpreted reflection only creates metadata for interfaces.
 * A union nested inside another union therefore has no entry in `types`, causing
 * subtype checks such as UIContainer -> UIElement -> FlowElement to stop early.
 */
function repairNestedUnionReflection(parsedGrammar, reflection) {
    const hierarchy = collectTypeHierarchy(mergeTypesAndInterfaces(collectAst(parsedGrammar.grammarNode, {
        services: parsedGrammar.grammarServices,
    })));
    for (const name of hierarchy.superTypes.keys()) {
        if (!reflection.types[name]) {
            reflection.types[name] = {
                name,
                properties: {},
                superTypes: [...hierarchy.superTypes.get(name)],
            };
        }
    }
    // AbstractAstReflection caches subtype results. Discarding both caches is
    // required if the reflection has been consulted before this repair.
    const cachedReflection = reflection;
    cachedReflection.subtypes = {};
    cachedReflection.allSubtypes = {};
}
async function parseGrammar(grammar) {
    const grammarServices = createLangiumGrammarServices(EmptyFileSystem).grammar;
    const document = grammarServices.shared.workspace.LangiumDocumentFactory.fromString(grammar, URI.parse('memory:/grammar.langium'));
    await grammarServices.shared.workspace.DocumentBuilder.build([document], { validation: false });
    return {
        grammarNode: document.parseResult.value,
        grammarServices,
    };
}
async function createServices(dsl, parsedGrammar, sharedModule, module) {
    const services = await createServicesForGrammar(grammarConfig(dsl, parsedGrammar, sharedModule, module));
    repairNestedUnionReflection(parsedGrammar, services.shared.AstReflection);
    return services;
}
/** Build a DSL's services, falling back to Langium defaults for a broken author module. */
export async function createDslServices(dsl, sharedModule, onServicesLoadFailure) {
    const parsedGrammar = await parseGrammar(dsl.grammar);
    if (dsl.services) {
        try {
            return await withTimeout((async () => {
                const module = await loadServicesModule(dsl);
                return createServices(dsl, parsedGrammar, sharedModule, module);
            })(), config.dslServicesBuildTimeoutMs, 'Custom services build');
        }
        catch (error) {
            console.error(`[dsl-services] Failed to load services for ${dsl.acronym} ${dsl.version} `
                + `(${dsl.status}); falling back to Langium defaults:`, error);
            try {
                onServicesLoadFailure?.(error);
            }
            catch (notificationError) {
                console.error('[dsl-services] Failed to surface the services load error:', notificationError);
            }
        }
    }
    return createServices(dsl, parsedGrammar, sharedModule);
}
/**
 * Serve one LSP session for one DSL over the given message reader/writer
 * (backed by a WebSocket). Every session gets its own Langium services
 * instance because document state and the LSP connection are per client;
 * building services from a grammar string takes only a few milliseconds.
 */
export async function serveLspSession(reader, writer, dsl) {
    const connection = createConnection(reader, writer);
    let servicesLoadError;
    const services = await createDslServices(dsl, {
        // Injected last, so it overrides the default (absent) connection and
        // turns the grammar services into a fully wired language server.
        lsp: {
            Connection: () => connection,
        },
    }, (error) => {
        servicesLoadError = error;
    });
    if (servicesLoadError !== undefined) {
        services.shared.lsp.LanguageServer.onInitialized(() => {
            const detail = servicesLoadError instanceof Error
                ? servicesLoadError.message
                : String(servicesLoadError);
            void connection.sendNotification(ShowMessageNotification.type, {
                type: MessageType.Error,
                message: `Custom services for ${dsl.acronym} ${dsl.version} failed to load. `
                    + `The editor is using default language services for this session. ${detail}`,
            });
        });
    }
    startLanguageServer(services.shared);
}
