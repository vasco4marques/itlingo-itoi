import assert from 'node:assert/strict';
import { createDslServices } from '../dist/lsp.js';

const grammar = 'grammar Example entry Model: name=ID; terminal ID: /[a-z]+/;';

function dsl(services, servicesDigest) {
    return {
        acronym: 'EXAMPLE',
        name: 'Example',
        version: '1.0',
        status: 'draft',
        languageId: 'itlingo-example-draft',
        extensions: ['example-draft'],
        grammar,
        digest: 'grammar-digest',
        services,
        servicesDigest,
    };
}

const customModule = `
import { DefaultNameProvider } from 'langium';

class MarkedNameProvider extends DefaultNameProvider {
    marker = 'author-module-loaded';
}

export default function createModule() {
    return {
        references: {
            NameProvider: services => new MarkedNameProvider(services),
        },
    };
}
`;

const customServices = await createDslServices(dsl(customModule, 'custom-services-test-v1'));
assert.equal(
    customServices.references.NameProvider.marker,
    'author-module-loaded',
    'the author module overrides a default Langium service',
);

const originalConsoleError = console.error;
const loggedErrors = [];
console.error = (...args) => loggedErrors.push(args);
try {
    const fallbackServices = await createDslServices(dsl(
        'export default function createModule() { throw new Error("broken author module"); }',
        'broken-services-test-v1',
    ));
    assert.equal(
        fallbackServices.references.NameProvider.marker,
        undefined,
        'a module evaluation failure falls back to the default services',
    );
} finally {
    console.error = originalConsoleError;
}
assert.equal(loggedErrors.length, 1, 'the services fallback is logged');
assert.match(String(loggedErrors[0][0]), /falling back to Langium defaults/);

console.log('SERVICES MODULE TEST PASSED');
