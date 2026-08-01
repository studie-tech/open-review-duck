import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
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

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  Object.entries(assets).map(([fileName, moduleName]) =>
    copyFile(
      isAbsolute(moduleName)
        ? moduleName
        : moduleName.startsWith("vendor/")
          ? join(repositoryRoot, moduleName)
          : require.resolve(moduleName),
      join(outputDirectory, fileName),
    ),
  ),
);
