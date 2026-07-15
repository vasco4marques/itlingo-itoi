import { config } from './config.js';
import { fetchDsls } from './cloud.js';
import { extractKeywords } from './grammar-inspect.js';
function compareVersionsDesc(a, b) {
    return (b.version || '').localeCompare(a.version || '', undefined, { numeric: true });
}
/**
 * Reduce the raw cloud DSL list to at most two grammars per acronym: the
 * newest active version and the newest draft. Drafts have a decorated
 * language id and file extension so both versions can be opened at once.
 * Operator-reserved extensions are dropped, and an extension already claimed
 * by another dynamic DSL is not claimed twice.
 */
export function resolveRegistry(dsls) {
    const byAcronym = new Map();
    for (const dsl of dsls) {
        const acronym = (dsl.acronym || '').trim();
        if (!acronym || !dsl.grammar) {
            continue;
        }
        const list = byAcronym.get(acronym) ?? [];
        list.push(dsl);
        byAcronym.set(acronym, list);
    }
    const picked = [];
    for (const versions of byAcronym.values()) {
        const active = versions
            .filter((dsl) => dsl.status === 'active')
            .sort(compareVersionsDesc);
        const drafts = versions
            .filter((dsl) => dsl.status === 'draft')
            .sort(compareVersionsDesc);
        if (active[0]) {
            picked.push(active[0]);
        }
        if (drafts[0]) {
            picked.push(drafts[0]);
        }
    }
    // Active DSLs claim extensions first, then drafts.
    picked.sort((a, b) => a.status === b.status ? a.acronym.localeCompare(b.acronym) : a.status === 'active' ? -1 : 1);
    // Reserve the decorated draft namespace for every operator exclusion too.
    const claimed = new Set(config.reservedExtensions.flatMap((ext) => [ext, `${ext}-draft`]));
    const resolved = [];
    for (const dsl of picked) {
        const isDraft = dsl.status === 'draft';
        const extensions = (dsl.file_extensions ?? [])
            .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
            .map((ext) => isDraft ? `${ext}-draft` : ext)
            .filter((ext) => ext.length > 0 && !claimed.has(ext));
        if (extensions.length === 0) {
            continue;
        }
        extensions.forEach((ext) => claimed.add(ext));
        // An acronym ending in "-draft" can collide with another acronym's
        // decorated draft language id. Such DSL names are not currently used.
        const acronym = dsl.acronym.trim().toLowerCase();
        resolved.push({
            acronym: dsl.acronym,
            name: dsl.name,
            version: dsl.version,
            status: dsl.status,
            languageId: `itlingo-${acronym}${isDraft ? '-draft' : ''}`,
            extensions,
            grammar: dsl.grammar,
            digest: dsl.digest,
        });
    }
    return resolved;
}
export async function getRegistry(iv, t) {
    return resolveRegistry(await fetchDsls(iv, t));
}
/** Registration metadata sent to the ITOI frontend (grammar text omitted). */
export function toClientDescriptor(dsl) {
    return {
        acronym: dsl.acronym,
        name: dsl.name,
        version: dsl.version,
        status: dsl.status,
        languageId: dsl.languageId,
        extensions: dsl.extensions,
        keywords: extractKeywords(dsl.grammar, dsl.digest),
    };
}
