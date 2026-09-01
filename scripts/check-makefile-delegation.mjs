import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const makefile = await readFile(join(repositoryRoot, "Makefile"), "utf8");
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);

/** Returns the tab-indented recipe for one Make target. */
function recipe(target) {
  const match = makefile.match(
    new RegExp(`^${target}:[^\\n]*\\n((?:\\t[^\\n]*(?:\\n|$))+)`, "m"),
  );
  if (!match) throw new Error(`Make target is missing a recipe: ${target}`);
  return match[1];
}

/** Requires one package-script delegation and rejects duplicated tool calls. */
function requireDelegation(target, script, forbidden) {
  const body = recipe(target);
  if (!body.includes(`pnpm ${script}`)) {
    throw new Error(`make ${target} must delegate to pnpm ${script}`);
  }
  for (const command of forbidden) {
    if (body.includes(command)) {
      throw new Error(`make ${target} duplicates package behavior: ${command}`);
    }
  }
}

requireDelegation("build", "build", ["next build", "prepare-tree-sitter"]);
requireDelegation("check", "check", ["vitest", "biome", "tsc --noEmit"]);
requireDelegation("start", "dev --port", [
  "next dev",
  "prepare-tree-sitter",
  "generate-rulebooks",
]);

const preparation = packageJson.scripts["assets:prepare"];
for (const required of [
  "prepare-tree-sitter.mjs",
  "generate-rulebooks.mjs",
  "check-generated-assets.mjs",
]) {
  if (!preparation?.includes(required)) {
    throw new Error(`assets:prepare is missing ${required}`);
  }
}

for (const script of ["build", "dev", "test", "test:run", "test:integration"]) {
  if (!packageJson.scripts[script]?.includes("pnpm assets:prepare")) {
    throw new Error(`${script} must delegate to pnpm assets:prepare`);
  }
}

if (!packageJson.scripts.check?.includes("pnpm biome:scope:check")) {
  throw new Error("check must verify that Biome processes repository sources");
}

process.stdout.write(
  "Verified Make delegation and generated-asset preparation.\n",
);
