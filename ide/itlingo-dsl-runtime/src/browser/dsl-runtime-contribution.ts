import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import * as monaco from '@theia/monaco-editor-core';
import { DslDescriptor, DslLanguageClient } from './dsl-lsp-client';

const log = {
    info: (msg: string, ...rest: unknown[]) => console.info(`[dsl-runtime] ${msg}`, ...rest),
    warn: (msg: string, ...rest: unknown[]) => console.warn(`[dsl-runtime] ${msg}`, ...rest),
};

/**
 * On startup: fetch the session launch tokens (already exposed by the ITOI
 * backend's /getWorkspace), ask the dsl-lsp-service which ITLingoCloud DSLs
 * are available, register each one in Monaco, and connect a language client.
 * A defensive check below skips any extension Monaco already knows, while the
 * sidecar's optional reservation list can exclude operator-owned extensions.
 */
@injectable()
export class DslRuntimeFrontendContribution implements FrontendApplicationContribution {

    onStart(): void {
        this.setup().catch(error => log.warn('dynamic DSL setup skipped', error));
    }

    protected async setup(): Promise<void> {
        const workspaceResponse = await fetch('/getWorkspace', {
            credentials: 'include',
            headers: { 'Cache-Control': 'no-cache' },
        });
        if (!workspaceResponse.ok) {
            log.info('no ITOI session (getWorkspace not available); dynamic DSLs disabled');
            return;
        }
        const workspace = await workspaceResponse.json();
        const iv: string | undefined = workspace?.tokens?.iv;
        const t: string | undefined = workspace?.tokens?.t;
        if (!iv || !t) {
            log.info('session has no launch tokens; dynamic DSLs disabled');
            return;
        }

        const configResponse = await fetch('/dslservice/config');
        if (!configResponse.ok) {
            log.warn('dsl-lsp-service config endpoint unavailable');
            return;
        }
        const config = await configResponse.json();
        const baseUrl = String(config.url || '').replace(/\/+$/, '');
        if (!baseUrl) {
            log.warn('dsl-lsp-service URL not configured');
            return;
        }

        const query = `iv=${encodeURIComponent(iv)}&t=${encodeURIComponent(t)}`;
        let dsls: DslDescriptor[];
        try {
            const dslsResponse = await fetch(`${baseUrl}/dsls?${query}`);
            if (!dslsResponse.ok) {
                log.warn(`dsl-lsp-service /dsls returned HTTP ${dslsResponse.status}`);
                return;
            }
            dsls = (await dslsResponse.json()).dsls ?? [];
        } catch (error) {
            log.warn('could not reach dsl-lsp-service', error);
            return;
        }

        if (dsls.length === 0) {
            log.info('no dynamic DSLs available');
            return;
        }

        const webSocketBase = baseUrl.replace(/^http/, 'ws');
        for (const dsl of dsls) {
            try {
                await this.registerDsl(dsl, `${webSocketBase}/lsp/${encodeURIComponent(dsl.languageId)}?${query}`);
            } catch (error) {
                log.warn(`failed to set up DSL ${dsl.acronym}`, error);
            }
        }
    }

    protected async registerDsl(dsl: DslDescriptor, webSocketUrl: string): Promise<void> {
        const alreadyClaimed = new Set<string>();
        for (const language of monaco.languages.getLanguages()) {
            for (const ext of language.extensions ?? []) {
                alreadyClaimed.add(ext.replace(/^\./, '').toLowerCase());
            }
        }
        const extensions = dsl.extensions.filter(ext => !alreadyClaimed.has(ext));
        if (extensions.length === 0) {
            log.info(`skipping ${dsl.acronym}: all its extensions are already registered`);
            return;
        }

        monaco.languages.register({
            id: dsl.languageId,
            aliases: [dsl.acronym, dsl.name],
            extensions: extensions.map(ext => `.${ext}`),
        });
        this.registerHighlighting(dsl);

        const client = new DslLanguageClient({ ...dsl, extensions }, webSocketUrl);
        await client.start();
        log.info(`registered DSL ${dsl.acronym} ${dsl.version} (${dsl.status}) for .${extensions.join(', .')}`);
    }

    protected registerHighlighting(dsl: DslDescriptor): void {
        // Basic Monarch highlighter built from the grammar's keywords plus
        // the comment/string terminals conventional in Langium grammars.
        monaco.languages.setMonarchTokensProvider(dsl.languageId, {
            keywords: dsl.keywords,
            tokenizer: {
                root: [
                    [/[a-zA-Z_][\w-]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
                    [/"([^"\\]|\\.)*"?/, 'string'],
                    [/'([^'\\]|\\.)*'?/, 'string'],
                    [/\/\/.*$/, 'comment'],
                    [/\/\*/, 'comment', '@comment'],
                    [/\d+(\.\d+)?/, 'number'],
                ],
                comment: [
                    [/[^/*]+/, 'comment'],
                    [/\*\//, 'comment', '@pop'],
                    [/[/*]/, 'comment'],
                ],
            },
        } as any);
        monaco.languages.setLanguageConfiguration(dsl.languageId, {
            comments: { lineComment: '//', blockComment: ['/*', '*/'] },
            brackets: [['{', '}'], ['[', ']'], ['(', ')']],
            autoClosingPairs: [
                { open: '{', close: '}' },
                { open: '[', close: ']' },
                { open: '(', close: ')' },
                { open: '"', close: '"' },
                { open: "'", close: "'" },
            ],
        });
    }
}
