# Language parsers

Every supported language is parsed by its production Tree-sitter grammar. The
root `tree-sitter-languages.json` manifest is the single source of truth for
grammar assets, extensions, and conventional filenames. The shared Tree-sitter
adapter owns declaration extraction, test-framework recognition, context
detection, naming, and dependency inference. Languages with deeper semantic
requirements can layer focused extraction behavior onto that adapter.

## Adding a language

1. Add its grammar asset, extensions, and conventional filenames to
   `../../../../tree-sitter-languages.json`.
2. Define its syntax shape and semantic extraction rules in
   `tree-sitter-adapter.ts`.
3. Add a representative, syntax-valid fixture to
   `../../../test/tree-sitter-language-fixtures.ts`. The exhaustive language
   support suites will then verify asset loading, parsing, path detection,
   analysis, and browser highlighting.
4. Add import node types to `../../../lib/tree-sitter-imports.ts` when the
   grammar has module syntax.
5. Bump `CURRENT_ANALYSIS_VERSION` in `../engine.ts` so existing pull requests
   are reprocessed.

`scripts/prepare-tree-sitter.mjs` reads the manifest and copies all package and
vendored WASM assets into the public directory. Normal development and
production builds do not compile grammars. The QL and MDX assets are pinned
under `vendor/tree-sitter` and can be reproduced with
`scripts/update-tree-sitter-grammars.mjs`.

An adapter should prefer small semantic units that can be reviewed bottom-up:
documentation belongs with its declaration, type shells should not repeat
member bodies, imports are context rather than standalone work, tests and
lifecycle hooks should be distinct, and direct dependencies should point to
stable keys whenever they can be inferred safely.

Unknown text formats are reviewed as whole files, and so are data formats: a
shape that sets `reviewsWholeFile` declares no reviewable constructs, because a
key in a manifest cannot be confirmed apart from the document around it. Adding
a data format is one line — give it `dataDocumentShape`. Binary files are
represented by a notice and their contents are never retained in review units.
