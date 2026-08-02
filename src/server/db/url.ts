/**
 * libpq accepts `sslrootcert=system` to select the operating system trust
 * store. node-postgres instead treats the value as a certificate file path.
 * Removing only this sentinel keeps `sslmode=verify-full` intact and lets
 * Node use its built-in system roots.
 */
export function normalizeNodePostgresUrl(connectionString: string) {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslrootcert") === "system") {
    url.searchParams.delete("sslrootcert");
  }
  if (
    url.hostname.endsWith(".pg.psdb.cloud") &&
    (!url.port || url.port === "5432")
  ) {
    url.port = "6432";
  }
  return url.toString();
}
