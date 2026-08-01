# Vendored Tree-sitter grammars

This directory contains the QL and MDX WebAssembly grammars, the only supported
grammars that are not published as browser-ready package artifacts. Regenerate
them with:

```sh
node scripts/update-tree-sitter-grammars.mjs
```

The update script checks out exact upstream revisions, builds ABI 14 parser
modules with Tree-sitter CLI 0.25.10, and preserves each upstream license under
`licenses/`. Normal development and production builds never compile or download
grammars; they copy these verified artifacts together with package-provided
grammars into `public/tree-sitter`.
