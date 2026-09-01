import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  await readFile(join(repositoryRoot, "tree-sitter-languages.json"), "utf8"),
);
const treeSitterDirectory = join(repositoryRoot, "public", "tree-sitter");
const treeSitterFiles = [
  "tree-sitter.js",
  "tree-sitter-browser-loader.js",
  "tree-sitter.wasm",
  ...Object.values(manifest.languages)
    .map((definition) => definition.asset)
    .filter(Boolean),
];

/** Fails when a generated runtime input is missing or empty. */
async function requireNonEmpty(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Generated asset is empty: ${path}`);
  }
}

await Promise.all(
  treeSitterFiles.map((fileName) =>
    requireNonEmpty(join(treeSitterDirectory, fileName)),
  ),
);

const corpusPath = join(
  repositoryRoot,
  "src",
  "server",
  "review",
  "deep",
  "rulebooks",
  "corpus.generated.ts",
);
await requireNonEmpty(corpusPath);
const corpus = await readFile(corpusPath, "utf8");
for (const exportName of [
  "RULEBOOK_DEFAULT",
  "RULEBOOK_PATTERNS",
  "RULEBOOK_DOCUMENTS",
  "RULEBOOK_DIGEST",
]) {
  if (!corpus.includes(`export const ${exportName}`)) {
    throw new Error(`Generated rulebook corpus is missing ${exportName}`);
  }
}

process.stdout.write(
  `Verified ${treeSitterFiles.length} Tree-sitter assets and the generated rulebook corpus.\n`,
);
