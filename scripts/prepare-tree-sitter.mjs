import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(repositoryRoot, "public", "tree-sitter");
const webRuntimePath = fileURLToPath(import.meta.resolve("web-tree-sitter"));
const manifest = JSON.parse(
  await readFile(join(repositoryRoot, "tree-sitter-languages.json"), "utf8"),
);

const assets = {
  "tree-sitter.js": webRuntimePath,
  "tree-sitter-browser-loader.js": join(
    repositoryRoot,
    "scripts",
    "tree-sitter-browser-loader.js",
  ),
  "tree-sitter.wasm": "web-tree-sitter/tree-sitter.wasm",
  ...Object.fromEntries(
    Object.values(manifest.languages).flatMap((definition) =>
      definition.asset && definition.source
        ? [[definition.asset, definition.source]]
        : [],
    ),
  ),
};

/** Resolves one declared asset to the file the published copy is taken from. */
function sourcePath(moduleName) {
  if (isAbsolute(moduleName)) return moduleName;
  if (moduleName.startsWith("vendor/")) return join(repositoryRoot, moduleName);
  return require.resolve(moduleName);
}

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
const digests = await Promise.all(
  Object.entries(assets).map(async ([fileName, moduleName]) => {
    const content = await readFile(sourcePath(moduleName));
    await writeFile(join(outputDirectory, fileName), content);
    return `${fileName}:${createHash("sha256").update(content).digest("hex")}`;
  }),
);

// The published assets keep stable file names, so the loader hands the browser
// an identifier to append to their URLs. Any changed byte changes it, which is
// what lets the served grammars be cached immutably.
const version = createHash("sha256")
  .update(digests.sort().join("\n"))
  .digest("hex")
  .slice(0, 16);
const loaderFile = join(outputDirectory, "tree-sitter-browser-loader.js");
await writeFile(
  loaderFile,
  `${await readFile(loaderFile, "utf8")}\nglobalThis.__openReviewDuckTreeSitterVersion = ${JSON.stringify(version)};\n`,
);
