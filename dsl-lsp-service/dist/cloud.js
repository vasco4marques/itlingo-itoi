import { config } from './config.js';
const cache = new Map();
/**
 * Fetch the DSL list from ITLingoCloud, authenticated with the ITOI launch
 * token (`Authorization: Bearer <iv>:<t>` — the same scheme the ITOI backend
 * uses for get-file-list / download-file). Results are cached per token for
 * a short TTL so publishing or editing a grammar is picked up on the next
 * reconnect without restarting this service.
 */
export async function fetchDsls(iv, t) {
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
    const body = (await response.json());
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
