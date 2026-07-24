import assert from 'node:assert/strict';
import { URI } from 'langium';
import { createDslServices, serveLspSession } from '../dist/lsp.js';

assert.equal(
    serveLspSession.length,
    3,
    'serveLspSession accepts only the LSP reader, writer, and resolved DSL',
);

const grammar = `
grammar Example

entry Model:
    entities+=Entity*
    uses+=Derived*;

Entity:
    'entity' name=ID '{' attributes+=Attribute* '}';

Attribute:
    'attribute' name=ID;

Derived:
    'derived' from=[Attribute:QualifiedName];

QualifiedName returns string:
    ID ('.' ID)*;

terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
hidden terminal WS: /\\s+/;
`;

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

const qualifiedScopeModule = `
import { DefaultScopeProvider } from 'langium';

class QualifiedAttributeScopeProvider extends DefaultScopeProvider {
    getScope(context) {
        if (context.property !== 'from') {
            return super.getScope(context);
        }
        let model = context.container;
        while (model.$container) {
            model = model.$container;
        }
        const descriptions = model.entities.flatMap(entity =>
            entity.attributes.map(attribute =>
                this.descriptions.createDescription(
                    attribute,
                    entity.name + '.' + attribute.name,
                ),
            ),
        );
        return this.createScope(descriptions, super.getScope(context));
    }
}

export default function createModule() {
    return {
        references: {
            ScopeProvider: services => new QualifiedAttributeScopeProvider(services),
        },
    };
}
`;

async function diagnosticsFor(services, source, suffix) {
    const document = services.shared.workspace.LangiumDocumentFactory.fromString(
        source,
        URI.parse(`memory:///qualified-${suffix}.example-draft`),
    );
    await services.shared.workspace.DocumentBuilder.build(
        [document],
        { validation: true },
    );
    return document.diagnostics ?? [];
}

const defaultServices = await createDslServices(dsl(undefined, undefined));
const validQualifiedSource = 'entity e_VAT { attribute VATValue } derived e_VAT.VATValue';
const defaultDiagnostics = await diagnosticsFor(
    defaultServices,
    validQualifiedSource,
    'default',
);
assert.ok(
    defaultDiagnostics.some(diagnostic =>
        diagnostic.message.includes("Could not resolve reference to Attribute named 'e_VAT.VATValue'"),
    ),
    'Langium defaults do not resolve the containment-qualified attribute',
);

const qualifiedServices = await createDslServices(dsl(
    qualifiedScopeModule,
    'qualified-scope-test-v1',
));
assert.deepEqual(
    await diagnosticsFor(qualifiedServices, validQualifiedSource, 'valid'),
    [],
    'the author ScopeProvider resolves e_VAT.VATValue',
);
const typoDiagnostics = await diagnosticsFor(
    qualifiedServices,
    'entity e_VAT { attribute VATValue } derived e_VAT.Nope',
    'typo',
);
assert.ok(
    typoDiagnostics.some(diagnostic =>
        diagnostic.message.includes("Could not resolve reference to Attribute named 'e_VAT.Nope'"),
    ),
    'an unknown qualified attribute still produces a linking error',
);

const originalConsoleError = console.error;
const loggedErrors = [];
const surfacedErrors = [];
console.error = (...args) => loggedErrors.push(args);
try {
    const fallbackServices = await createDslServices(dsl(
        'export default function createModule() { throw new Error("broken author module"); }',
        'broken-services-test-v1',
    ), undefined, (error) => surfacedErrors.push(error));
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
assert.equal(surfacedErrors.length, 1, 'the services fallback can be surfaced to the client');
assert.match(String(surfacedErrors[0]), /broken author module/);

console.log('SERVICES MODULE TEST PASSED');
