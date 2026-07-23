function normalizeBaseUrl(url: string): string {
    return url.endsWith('/') ? url : url + '/';
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
    port: positiveInteger(process.env.PORT, 3001),

    /** Base URL of ITLingoCloud (Odoo), same semantics as ITOI's ITLINGO_CLOUD_URL. */
    itlingoCloudUrl: normalizeBaseUrl(process.env.ITLINGO_CLOUD_URL ?? 'http://localhost:8069/'),

    /**
     * Optional file extensions (without dot) that operators want to exclude
     * from dynamic registration, for example to avoid a local extension
     * collision. No extensions are reserved by default.
     */
    reservedExtensions: (process.env.RESERVED_EXTENSIONS ?? '')
        .split(',')
        .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
        .filter((ext) => ext.length > 0),

    /** How long a fetched DSL list is reused before re-asking ITLingoCloud. */
    dslCacheTtlMs: positiveInteger(process.env.DSL_CACHE_TTL_MS, 60000),

    /**
     * Maximum wall-clock time for loading an author module and constructing
     * its Langium services before this session falls back to defaults.
     */
    dslServicesBuildTimeoutMs: positiveInteger(
        process.env.DSL_SERVICES_BUILD_TIMEOUT_MS,
        10000,
    ),
};
