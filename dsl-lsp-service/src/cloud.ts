import { config } from './config.js';

/** One DSL row as served by ITLingoCloud's GET /token_api/get-dsls. */
export interface CloudDsl {
    id: number;
    acronym: string;
    name: string;
    version: string;
    status: 'active' | 'draft';
    file_extensions: string[];
    grammar: string;
    digest: string;
    /** Compiled ESM Langium services module supplied by the DSL author. */
    services?: string;
    /** Digest of the compiled services artifact, used as its runtime cache key. */
    services_digest?: string;
}

/** One trusted specification from the token's workspace/organization scope. */
export interface CloudDslSource {
    id: number;
    name: string;
    content: string;
    digest: string;
    packages?: string[];
}

interface CacheEntry {
    expiresAt: number;
    dsls: CloudDsl[];
}

const cache = new Map<string, CacheEntry>();
const sourceCache = new Map<string, {
    expiresAt: number;
    sources: CloudDslSource[];
}>();

/**
 * Fetch the DSL list from ITLingoCloud, authenticated with the ITOI launch
 * token (`Authorization: Bearer <iv>:<t>` — the same scheme the ITOI backend
 * uses for get-file-list / download-file). Results are cached per token for
 * a short TTL so publishing or editing a grammar is picked up on the next
 * reconnect without restarting this service.
 */
export async function fetchDsls(iv: string, t: string): Promise<CloudDsl[]> {
    const cacheKey = `${iv}:${t}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.dsls;
    }

    const url = `${config.itlingoCloudUrl}token_api/get-dsls`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${iv}:${t}` },
    });
    if (!response.ok) {
        throw new Error(`ITLingoCloud get-dsls failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { dsls?: CloudDsl[] };
    const dsls = Array.isArray(body.dsls) ? body.dsls : [];

    cache.set(cacheKey, { expiresAt: Date.now() + config.dslCacheTtlMs, dsls });
    // Opportunistic cleanup so stale sessions do not accumulate forever.
    for (const [key, entry] of cache) {
        if (entry.expiresAt <= Date.now()) {
            cache.delete(key);
        }
    }
    return dsls;
}

export async function fetchDslSources(
    dslId: number,
    iv: string,
    t: string,
): Promise<CloudDslSource[]> {
    const cacheKey = `${iv}:${t}:${dslId}`;
    const cached = sourceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.sources;
    }
    const url = `${config.itlingoCloudUrl}token_api/get-dsl-sources/${dslId}`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${iv}:${t}` },
    });
    if (!response.ok) {
        throw new Error(
            `ITLingoCloud get-dsl-sources failed: HTTP ${response.status}`,
        );
    }
    const body = (await response.json()) as {
        sources?: CloudDslSource[];
        conflicting_packages?: string[];
    };
    const conflicts = new Set(
        Array.isArray(body.conflicting_packages)
            ? body.conflicting_packages
            : [],
    );
    const sources = (Array.isArray(body.sources) ? body.sources : []).filter(
        source => !(source.packages ?? []).some(pkg => conflicts.has(pkg)),
    );
    sourceCache.set(cacheKey, {
        expiresAt: Date.now() + config.dslCacheTtlMs,
        sources,
    });
    for (const [key, entry] of sourceCache) {
        if (entry.expiresAt <= Date.now()) {
            sourceCache.delete(key);
        }
    }
    return sources;
}
