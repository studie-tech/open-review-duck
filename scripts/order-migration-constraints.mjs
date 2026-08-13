import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(repositoryRoot, "drizzle");
const breakpoint = "--> statement-breakpoint";
const header = [
  "-- Foreign keys are emitted after every index because drizzle-kit orders",
  "-- composite keys ahead of the unique indexes they reference, which",
  "-- Postgres rejects with 42830 on a fresh database.",
].join("\n");

/** Reports whether a statement adds a foreign key to an existing table. */
function isForeignKeyStatement(statement) {
  return /ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY/s.test(statement);
}

/**
 * Moves every foreign key after every other statement.
 *
 * A composite foreign key requires a unique index on the referenced columns to
 * exist first, and drizzle-kit emits constraints before indexes.
 */
function orderStatements(sql) {
  const statements = sql
    .split(breakpoint)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => statement.replace(new RegExp(`^${header}\n*`), ""));
  const keys = statements.filter(isForeignKeyStatement);
  if (keys.length === 0) return null;
  const rest = statements.filter(
    (statement) => !isForeignKeyStatement(statement),
  );
  return `${header}\n${[...rest, ...keys].join(`\n${breakpoint}\n`)}`;
}

const check = process.argv.includes("--check");
let failed = false;

for (const name of readdirSync(migrationDirectory).filter((n) =>
  n.endsWith(".sql"),
)) {
  const path = join(migrationDirectory, name);
  const current = readFileSync(path, "utf8");
  const ordered = orderStatements(current);
  if (ordered === null || ordered.trim() === current.trim()) continue;
  if (check) {
    process.stderr.write(
      `${name} orders a foreign key before an index it depends on. Run 'pnpm db:order'.\n`,
    );
    failed = true;
    continue;
  }
  writeFileSync(path, `${ordered}\n`);
  process.stdout.write(`Reordered ${name}.\n`);
}

if (failed) process.exit(1);
