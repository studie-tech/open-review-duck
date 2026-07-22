# Language parsers

Each language owns one folder containing its adapter and focused fixtures. The
registry in `index.ts` is intentionally the only place that knows which
parsers are installed.

## Adding a language

1. Add the language identifier and its extensions or conventional filenames
   in `../types.ts`.
2. Create `<language>/index.ts` and export a `LanguageAdapter`.
3. Keep syntax masking, declaration rules, test-framework recognition, import
   preamble detection, naming, and dependency inference inside that folder.
4. Add `<language>/index.test.ts` with representative production and test code.
5. Register the adapter in `index.ts` and bump `CURRENT_ANALYSIS_VERSION` in
   `../engine.ts` so existing pull requests are reprocessed.

An adapter should prefer small semantic units that can be reviewed bottom-up:
documentation belongs with its declaration, type shells should not repeat
member bodies, imports are context rather than standalone work, tests and
lifecycle hooks should be distinct, and direct dependencies should point to
stable keys whenever they can be inferred safely.

Files without a registered parser are still reviewed through the full-text
fallback. Binary files are represented by a notice and their contents are
never retained in review units.
