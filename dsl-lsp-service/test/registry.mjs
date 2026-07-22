import assert from 'node:assert/strict';
import { resolveRegistry, toClientDescriptor } from '../dist/registry.js';

const grammar = 'grammar Example entry Model: name=ID; terminal ID: /[a-z]+/;';

function dsl({ acronym = 'PSL', version, status, fileExtensions = ['psl'], services, servicesDigest }) {
    return {
        acronym,
        name: 'Project Specification Language',
        version,
        status,
        file_extensions: fileExtensions,
        grammar,
        digest: `${status}-${version}`,
        services,
        services_digest: servicesDigest,
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
    summary(resolveRegistry([
        dsl({ acronym: 'RSL', version: '1.0', status: 'active', fileExtensions: ['rsl'] }),
        dsl({ acronym: 'RSL', version: '1.1', status: 'draft', fileExtensions: ['rsl'] }),
    ])),
    [
        { languageId: 'itlingo-rsl', extensions: ['rsl'], status: 'active', version: '1.0' },
        { languageId: 'itlingo-rsl-draft', extensions: ['rsl-draft'], status: 'draft', version: '1.1' },
    ],
    'formerly bundled language extensions use the dynamic path too',
);

const [dslWithServices] = resolveRegistry([
    dsl({
        version: '2.0',
        status: 'active',
        services: 'export default { references: {} };',
        servicesDigest: 'services-digest-2.0',
    }),
]);
assert.equal(dslWithServices.services, 'export default { references: {} };');
assert.equal(dslWithServices.servicesDigest, 'services-digest-2.0');
const descriptor = toClientDescriptor(dslWithServices);
assert.equal(descriptor.hasServices, true, 'client metadata identifies DSLs with custom services');
assert.equal('services' in descriptor, false, 'services code is never sent to the browser client');

const [dslWithoutServices] = resolveRegistry([dsl({ version: '2.1', status: 'active' })]);
assert.equal(toClientDescriptor(dslWithoutServices).hasServices, false);

console.log('REGISTRY TEST PASSED');
