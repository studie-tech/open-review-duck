import { treeSitterAdapter } from "../tree-sitter-adapter";

/**
 * Syntax that only C++ has, used to read a header C and C++ both call `.h`.
 *
 * The convention in a great deal of C++ — Chromium, LLVM, the Google style —
 * is to name headers `.h`, which the manifest gives to C. The C grammar reads
 * `namespace pond {` as a function definition and hands back the whole
 * namespace as one card, so a header holding a dozen classes becomes a single
 * declaration. Any one of these markers settles it, and a C header that has
 * none keeps the C grammar.
 */
const cppOnlySyntax =
  /\bnamespace\s+[\w:]*\s*\{|\btemplate\s*<|\bclass\s+\w|\b(?:public|private|protected)\s*:|\w::\w/;

export const cppAdapter = treeSitterAdapter("cpp", {
  matches: ({ path, content }) =>
    /\.h$/i.test(path) && cppOnlySyntax.test(content),
});
