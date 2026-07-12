import assert from 'node:assert/strict';
import { resolveRegistry } from '../dist/registry.js';

const grammar = 'grammar Example entry Model: name=ID; terminal ID: /[a-z]+/;';

function dsl({ acronym = 'PSL', version, status, fileExtensions = ['psl'] }) {
    return {
        acronym,
        name: 'Project Specification Language',
        version,
        status,
        file_extensions: fileExtensions,
        grammar,
        digest: `${status}-${version}`,
    };
}

function summary(dsls) {
    return dsls.map(({ languageId, extensions, status, version }) => ({
        languageId,
        extensions,
        status,
        version,
    }));
}

assert.deepEqual(
    summary(resolveRegistry([
        dsl({ version: '1.0', status: 'active' }),
        dsl({ version: '1.1', status: 'draft' }),
        dsl({ version: '1.0', status: 'draft' }),
    ])),
    [
        { languageId: 'itlingo-psl', extensions: ['psl'], status: 'active', version: '1.0' },
        { languageId: 'itlingo-psl-draft', extensions: ['psl-draft'], status: 'draft', version: '1.1' },
    ],
    'an active grammar and only the newest draft are both served',
);

assert.deepEqual(
    summary(resolveRegistry([dsl({ version: '1.1', status: 'draft' })])),
    [{ languageId: 'itlingo-psl-draft', extensions: ['psl-draft'], status: 'draft', version: '1.1' }],
    'a draft-only grammar retains the -draft identity',
);

assert.deepEqual(
    summary(resolveRegistry([dsl({ version: '1.0', status: 'active' })])),
    [{ languageId: 'itlingo-psl', extensions: ['psl'], status: 'active', version: '1.0' }],
    'an active-only grammar retains its canonical identity',
);

assert.deepEqual(
    resolveRegistry([dsl({ acronym: 'RSL', version: '1.1', status: 'draft', fileExtensions: ['rsl'] })]),
    [],
    'reserved bundled extensions are not exposed through the draft namespace',
);

console.log('REGISTRY TEST PASSED');
