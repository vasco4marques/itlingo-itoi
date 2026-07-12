function normalizeBaseUrl(url: string): string {
    return url.endsWith('/') ? url : url + '/';
}

export const config = {
    port: parseInt(process.env.PORT ?? '3001', 10),

    /** Base URL of ITLingoCloud (Odoo), same semantics as ITOI's ITLINGO_CLOUD_URL. */
    itlingoCloudUrl: normalizeBaseUrl(process.env.ITLINGO_CLOUD_URL ?? 'http://localhost:8069/'),

    /**
     * File extensions (without dot) owned by the statically built ITOI
     * extensions (asl-langium, rsl-vscode-extension). DSLs claiming these
     * extensions are never served dynamically, so the bundled extensions
     * are not shadowed or duplicated.
     */
    reservedExtensions: (process.env.RESERVED_EXTENSIONS ?? 'rsl,asl')
        .split(',')
        .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
        .filter((ext) => ext.length > 0),

    /** How long a fetched DSL list is reused before re-asking ITLingoCloud. */
    dslCacheTtlMs: parseInt(process.env.DSL_CACHE_TTL_MS ?? '60000', 10),
};
