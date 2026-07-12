import { config } from './config.js';
import { CloudDsl, fetchDsls } from './cloud.js';
import { extractKeywords } from './grammar-inspect.js';

/** A DSL resolved to one servable grammar version. */
export interface ResolvedDsl {
    acronym: string;
    name: string;
    version: string;
    status: 'active' | 'draft';
    /** Monaco language id, e.g. "itlingo-psl". */
    languageId: string;
    /** File extensions without dot, e.g. ["psl"]. */
    extensions: string[];
    grammar: string;
    digest: string;
}

function compareVersionsDesc(a: CloudDsl, b: CloudDsl): number {
    return (b.version || '').localeCompare(a.version || '', undefined, { numeric: true });
}

/**
 * Reduce the raw cloud DSL list to at most two grammars per acronym: the
 * newest active version and the newest draft. Drafts have a decorated
 * language id and file extension so both versions can be opened at once.
 * Extensions reserved by the bundled RSL/ASL extensions are dropped, and an
 * extension already claimed by another dynamic DSL is not claimed twice.
 */
export function resolveRegistry(dsls: CloudDsl[]): ResolvedDsl[] {
    const byAcronym = new Map<string, CloudDsl[]>();
    for (const dsl of dsls) {
        const acronym = (dsl.acronym || '').trim();
        if (!acronym || !dsl.grammar) {
            continue;
        }
        const list = byAcronym.get(acronym) ?? [];
        list.push(dsl);
        byAcronym.set(acronym, list);
    }

    const picked: CloudDsl[] = [];
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
    picked.sort((a, b) =>
        a.status === b.status ? a.acronym.localeCompare(b.acronym) : a.status === 'active' ? -1 : 1,
    );

    // Reserve the draft namespace too: RSL/ASL remain owned by their bundled
    // extensions even when ITLingoCloud returns a draft for either acronym.
    const claimed = new Set<string>(config.reservedExtensions.flatMap((ext) => [ext, `${ext}-draft`]));
    const resolved: ResolvedDsl[] = [];
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

export async function getRegistry(iv: string, t: string): Promise<ResolvedDsl[]> {
    return resolveRegistry(await fetchDsls(iv, t));
}

/** Registration metadata sent to the ITOI frontend (grammar text omitted). */
export function toClientDescriptor(dsl: ResolvedDsl) {
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
