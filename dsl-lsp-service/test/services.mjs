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
        URI.parse(
            `memory:///qualified-${suffix}${services.LanguageMetaData.fileExtensions[0]}`,
        ),
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

const nestedUnionGrammar = `
grammar NestedUnion

entry Model:
    elements+=(Target | Other | Direct | Use)*;

Use:
    'use' target=[Outer:ID];

Target:
    'target' name=ID;

Other:
    'other' name=ID;

Direct:
    'direct' name=ID;

type Outer = Middle | Direct;
type Middle = Target | Other;

terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
hidden terminal WS: /\\s+/;
`;

const nestedUnionServices = await createDslServices({
    ...dsl(undefined, undefined),
    grammar: nestedUnionGrammar,
    languageId: 'itlingo-nested-union',
    extensions: ['nested-union'],
});
assert.equal(
    nestedUnionServices.shared.AstReflection.isSubtype('Target', 'Outer'),
    true,
    'a concrete type is a subtype of an outer nested union',
);
assert.deepEqual(
    await diagnosticsFor(
        nestedUnionServices,
        'target targetOne use targetOne',
        'nested-union',
    ),
    [],
    'a reference typed at an outer nested union resolves',
);

const nestedUnionCustomServices = await createDslServices({
    ...dsl(customModule, 'nested-union-custom-services-test-v1'),
    grammar: nestedUnionGrammar,
    languageId: 'itlingo-nested-union-custom',
    extensions: ['nested-union-custom'],
});
assert.equal(
    nestedUnionCustomServices.shared.AstReflection.isSubtype('Target', 'Outer'),
    true,
    'the repair also applies when an author services module is loaded',
);

const importedEntityGrammar = `
grammar ImportedEntity

entry Model:
    packages+=Package*;

Package:
    'package' name=ID imports+=Import* entities+=Entity* uses+=Use*;

Import:
    'import' namespace=QualifiedName;

Entity:
    'entity' name=ID '{' attributes+=Attribute* '}';

Attribute:
    'attribute' name=ID;

Use:
    'use' target=[Attribute:QualifiedName];

QualifiedName returns string:
    ID ('.' ID)*;

terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
hidden terminal WS: /\\s+/;
`;

const importScopeModule = `
import {
    AstUtils, DefaultNameProvider, DefaultScopeComputation,
    DefaultScopeProvider, EMPTY_SCOPE, isNamed, stream, StreamScope,
} from 'langium';

const { getContainerOfType, getDocument, streamAllContents } = AstUtils;

class Names extends DefaultNameProvider {
    getQualifiedName(node) {
        if (!node.$container) return '';
        const parent = this.getQualifiedName(node.$container);
        const name = this.getName(node);
        return name ? (parent ? parent + '.' + name : name) : parent;
    }
}

class Exports extends DefaultScopeComputation {
    async collectExportedSymbols(document) {
        const descriptions = [];
        for (const node of streamAllContents(document.parseResult.value)) {
            if (!isNamed(node)) continue;
            const name = this.nameProvider.getQualifiedName(node);
            if (name) descriptions.push(this.descriptions.createDescription(node, name, document));
        }
        return descriptions;
    }
}

class Scopes extends DefaultScopeProvider {
    getGlobalScope(type, context) {
        const pkg = getContainerOfType(context.container, node => node.$type === 'Package');
        if (!pkg) return EMPTY_SCOPE;
        const currentUri = getDocument(context.container).uri.toString();
        const descriptions = this.indexManager.allElements(type)
            .filter(description => {
                if (description.documentUri.toString() === currentUri) return true;
                return pkg.imports.some(imp => description.name.startsWith(imp.namespace + '.'));
            })
            .map(description => {
                const ownPackage = getContainerOfType(description.node, node => node.$type === 'Package');
                const name = ownPackage && description.documentUri.toString() === currentUri
                    ? description.name.slice(ownPackage.name.length + 1)
                    : description.name.replace(/^[^.]+\\./, '');
                return { ...description, name };
            });
        return new StreamScope(stream(descriptions));
    }
}

export default () => ({ references: {
    NameProvider: () => new Names(),
    ScopeComputation: services => new Exports(services),
    ScopeProvider: services => new Scopes(services),
}});
`;

async function diagnosticsForDocuments(services, sources, suffix) {
    const documents = sources.map(([name, text]) =>
        services.shared.workspace.LangiumDocumentFactory.fromString(
            text,
            URI.parse(`memory:///imports-${suffix}-${name}${services.LanguageMetaData.fileExtensions[0]}`),
        ),
    );
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return documents.map(document => document.diagnostics ?? []);
}

const importedEntityServices = await createDslServices({
    ...dsl(importScopeModule, 'import-scope-test-v1'),
    grammar: importedEntityGrammar,
    languageId: 'itlingo-imported-entity',
    extensions: ['imported-entity'],
});
const [providerDiagnostics, consumerDiagnostics] = await diagnosticsForDocuments(
    importedEntityServices,
    [
        ['provider', 'package provider entity Entity { attribute Attribute }'],
        ['consumer', 'package consumer import provider use Entity.Attribute'],
    ],
    'matched',
);
assert.deepEqual(providerDiagnostics, [], 'the exporting document is valid');
assert.deepEqual(
    consumerDiagnostics,
    [],
    'an imported entity attribute resolves when both workspace documents are built together',
);

const [, foreignConsumerDiagnostics] = await diagnosticsForDocuments(
    importedEntityServices,
    [
        ['foreign-provider', 'package provider entity Entity { attribute Attribute }'],
        ['foreign-consumer', 'package consumer import unrelated use Entity.Attribute'],
    ],
    'unmatched',
);
assert.ok(
    foreignConsumerDiagnostics.some(diagnostic =>
        diagnostic.message.includes("Could not resolve reference to Attribute named 'Entity.Attribute'"),
    ),
    'a provisioned document whose package is not imported does not leak symbols into the scope',
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
