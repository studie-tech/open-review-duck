import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stateDirectory = requiredPath("LOCAL_DEV_STATE_DIR");
const databaseUrl = required("LOCAL_DEV_DATABASE_URL");
const applicationUrl = required("LOCAL_DEV_APP_URL");
const secretsDirectory = path.join(stateDirectory, "secrets");
const dataDirectory = path.join(stateDirectory, "data");
const environmentFile = path.join(stateDirectory, "environment");

if (process.env.LOCAL_DEV_SKIP_NEXT_CACHE !== "1") {
  await prepareNextCache();
}
await mkdir(path.join(dataDirectory, "objects"), {
  recursive: true,
  mode: 0o700,
});
await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
await chmod(stateDirectory, 0o700);
await chmod(dataDirectory, 0o700);
await chmod(secretsDirectory, 0o700);

const encryptionKey = await persistentSecret("encryption-key");
const storageIdKey = await persistentSecret("storage-id-key");
const environment = {
  ALLOW_PRIVATE_AI_HOSTS: "true",
  ALLOW_PRIVATE_PROVIDER_HOSTS: "true",
  APP_URL: applicationUrl,
  DATABASE_URL: databaseUrl,
  DEPLOYMENT_MODE: "local",
  ENCRYPTION_KEY: encryptionKey,
  LOCAL_DATA_DIR: dataDirectory,
  MIGRATION_DATABASE_URL: databaseUrl,
  NEXT_PUBLIC_DEPLOYMENT_MODE: "local",
  STORAGE_ID_KEY: storageIdKey,
  WORKFLOW_POSTGRES_URL: databaseUrl,
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
};
const contents = `${Object.entries(environment)
  .map(([name, value]) => `${name}=${shellQuote(value)}`)
  .join("\n")}\n`;
const temporaryEnvironmentFile = `${environmentFile}.${process.pid}.tmp`;
await writeFile(temporaryEnvironmentFile, contents, {
  encoding: "utf8",
  mode: 0o600,
});
await rename(temporaryEnvironmentFile, environmentFile);
await chmod(environmentFile, 0o600);

process.stdout.write(`Local development state: ${stateDirectory}\n`);

/** Reads a mandatory environment variable. */
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (/[\r\n\0]/u.test(value)) {
    throw new Error(`${name} contains an unsupported control character`);
  }
  return value;
}

/** Resolves a mandatory filesystem path. */
function requiredPath(name) {
  return path.resolve(required(name));
}

/** Creates a checkout-persistent, private 384-bit secret when one is absent. */
async function persistentSecret(name) {
  const secretFile = path.join(secretsDirectory, name);
  try {
    const existing = (await readFile(secretFile, "utf8")).trim();
    if (existing.length < 32) {
      throw new Error(`Local development secret ${name} is invalid`);
    }
    await chmod(secretFile, 0o600);
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const secret = randomBytes(48).toString("base64url");
  const temporarySecretFile = `${secretFile}.${process.pid}.tmp`;
  await writeFile(temporarySecretFile, `${secret}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporarySecretFile, secretFile);
  await chmod(secretFile, 0o600);
  return secret;
}

/** Quotes a value for the Bash environment file consumed by the Make target. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Removes output produced by another deployment target while retaining warm
 * local-development caches across ordinary restarts.
 */
async function prepareNextCache() {
  const nextDirectory = path.join(projectDirectory, ".next");
  const targetMarker = path.join(
    nextDirectory,
    ".reviewduck-deployment-target",
  );
  const previousTarget = await readFile(targetMarker, "utf8").catch(
    () => undefined,
  );
  if (previousTarget?.trim() !== "local") {
    await rm(nextDirectory, { force: true, recursive: true });
  }
  await mkdir(nextDirectory, { recursive: true });
  await writeFile(targetMarker, "local\n", { encoding: "utf8" });
}
