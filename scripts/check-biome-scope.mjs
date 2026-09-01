import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceExtension = /\.(?:cjs|css|js|json|jsonc|jsx|mjs|ts|tsx)$/;
const maintainedRoot = /^(?:scripts|src|tests)\//;

/** Runs a command and returns its captured standard output. */
function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout;
}

const sourceFiles = capture("git", ["ls-files", "--cached", "-z"])
  .split("\0")
  .filter(
    (path) =>
      maintainedRoot.test(path) &&
      sourceExtension.test(path) &&
      existsSync(join(repositoryRoot, path)),
  )
  .sort();

const probe = sourceFiles[0];
if (!probe) {
  throw new Error(
    "No Git-visible source file is available for the Biome probe",
  );
}

const biomeExecutable = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);
const biome = spawnSync(biomeExecutable, ["format", probe], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (biome.error) throw biome.error;
if (biome.status !== 0) {
  throw new Error(`Biome did not process the Git-visible source: ${probe}`);
}

process.stdout.write(
  `Biome processed ${probe}; ${sourceFiles.length} tracked source files are in scope.\n`,
);
