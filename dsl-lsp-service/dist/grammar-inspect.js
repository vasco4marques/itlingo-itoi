import { AstUtils, EmptyFileSystem, GrammarAST, URI } from 'langium';
import { createLangiumGrammarServices } from 'langium/grammar';
const grammarServices = createLangiumGrammarServices(EmptyFileSystem).grammar;
const keywordCache = new Map();
let inspectCounter = 0;
/**
 * Extract the word-like keywords of a Langium grammar (used by the frontend
 * to build a basic Monarch highlighter). Only needs a parse, not a full
 * build, so it is cheap; cached by content digest.
 */
export function extractKeywords(grammarText, digest) {
    const cached = keywordCache.get(digest);
    if (cached) {
        return cached;
    }
    const factory = grammarServices.shared.workspace.LangiumDocumentFactory;
    const document = factory.fromString(grammarText, URI.parse(`memory:/inspect-${inspectCounter++}.langium`));
    const grammar = document.parseResult.value;
    const keywords = new Set();
    if (grammar) {
        for (const node of AstUtils.streamAllContents(grammar)) {
            if (GrammarAST.isKeyword(node) && /^[A-Za-z_][\w-]*$/.test(node.value)) {
                keywords.add(node.value);
            }
        }
    }
    const result = [...keywords].sort();
    keywordCache.set(digest, result);
    return result;
}
