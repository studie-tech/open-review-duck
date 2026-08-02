import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = join(repositoryRoot, "vendor", "tree-sitter");
const licenseDirectory = join(outputDirectory, "licenses");
const treeSitterCliVersion = "0.25.10";

const compiledGrammars = [
  {
    language: "ql",
    grammarName: "ql",
    repository: "https://github.com/tree-sitter/tree-sitter-ql",
    revision: "5b8ee9adaa1f2a1ea958064b61f8feb0a5a886c0",
  },
  {
    language: "mdx",
    grammarName: "markdown_text",
    repository: "https://github.com/ophidiarium/tree-sitter-markdown-text.git",
    revision: "5082ca7cadda0e99b9d38b98d4f68344cc3e56e5",
  },
];

/** Runs a child process and rejects when it exits unsuccessfully. */
function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      ...options,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} failed${signal ? ` with ${signal}` : ` with code ${code ?? "unknown"}`}`,
          ),
        );
      }
    });
  });
}

/** Returns whether a filesystem path is accessible. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates the minimum Tree-sitter configuration required by the current CLI. */
async function ensureConfiguration(grammarDirectory, grammar) {
  const configurationPath = join(grammarDirectory, "tree-sitter.json");
  if (await exists(configurationPath)) return;
  await writeFile(
    configurationPath,
    `${JSON.stringify(
      {
        grammars: [
          {
            name: grammar.grammarName,
            scope: `source.${grammar.language}`,
            path: ".",
            "file-types": [grammar.language],
          },
        ],
        metadata: {
          version: "1.0.0",
          license: "SEE-LICENSE-IN-VENDORED-ASSET",
          description: `${grammar.language} grammar for ReviewDuck`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** Finds a grammar license file, preferring the grammar subdirectory. */
async function findLicense(checkoutDirectory, grammarDirectory) {
  for (const directory of [grammarDirectory, checkoutDirectory]) {
    const names = await readdir(directory);
    const license = names.find((name) =>
      /^(?:licen[cs]e|copying)(?:\.|$)/i.test(name),
    );
    if (license) return join(directory, license);
  }
  throw new Error(`No license file found below ${checkoutDirectory}`);
}

/** Checks out, compiles, and records one pinned grammar artifact. */
async function buildGrammar(grammar, temporaryRoot) {
  const checkoutDirectory = join(temporaryRoot, grammar.language);
  await mkdir(checkoutDirectory, { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: checkoutDirectory });
  await run("git", ["remote", "add", "origin", grammar.repository], {
    cwd: checkoutDirectory,
  });
  await run("git", ["fetch", "--depth", "1", "origin", grammar.revision], {
    cwd: checkoutDirectory,
  });
  await run("git", ["checkout", "--quiet", "FETCH_HEAD"], {
    cwd: checkoutDirectory,
  });

  const grammarDirectory = grammar.directory
    ? join(checkoutDirectory, grammar.directory)
    : checkoutDirectory;
  await ensureConfiguration(grammarDirectory, grammar);
  if (
    !(await exists(join(grammarDirectory, "src", "parser.c"))) &&
    (await exists(join(grammarDirectory, "grammar.js")))
  ) {
    await run(
      "npx",
      [
        "--yes",
        `tree-sitter-cli@${treeSitterCliVersion}`,
        "generate",
        "--abi",
        "14",
      ],
      { cwd: grammarDirectory },
    );
  }

  const outputPath = join(
    outputDirectory,
    `tree-sitter-${grammar.language}.wasm`,
  );
  await run(
    "npx",
    [
      "--yes",
      `tree-sitter-cli@${treeSitterCliVersion}`,
      "build",
      "--wasm",
      "--output",
      outputPath,
      grammarDirectory,
    ],
    { cwd: grammarDirectory },
  );
  const license = await findLicense(checkoutDirectory, grammarDirectory);
  await copyFile(
    license,
    join(licenseDirectory, `${grammar.language}-${basename(license)}`),
  );
}

await mkdir(licenseDirectory, { recursive: true });
const temporaryRoot = await mkdtemp(join(tmpdir(), "reviewduck-grammars-"));
try {
  for (const grammar of compiledGrammars) {
    console.log(
      `Building ${grammar.language} from ${grammar.repository}@${grammar.revision}`,
    );
    await buildGrammar(grammar, temporaryRoot);
  }
} finally {
  if (temporaryRoot.startsWith(`${tmpdir()}/reviewduck-grammars-`)) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
