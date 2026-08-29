export type DeploymentMode = "local" | "saas";

export const LOCAL_USER_ID = "reviewduck-local-user";
export const LOCAL_SESSION_COOKIE = "reviewduck_local_session";

/** Returns whether the selected Workflow world persists into ReviewDuck's PostgreSQL database. */
export function workflowUsesApplicationDatabase(targetWorld?: string) {
  return targetWorld === "@workflow/world-postgres";
}

/** Returns whether a hostname is confined to the current machine. */
export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

/** Returns whether a listen address is loopback or left unspecified for Docker. */
export function isSafeLocalListenAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    isLoopbackHostname(normalized) ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === ""
  );
}

/** Warns when a local process would bind a concrete public address. */
export function localListenAddressWarning(address: string) {
  if (isSafeLocalListenAddress(address)) return undefined;
  return `Local mode should bind loopback or an unspecified address, not ${address}. Publish Docker as 127.0.0.1:3000:3000.`;
}

/** Extracts a normalized hostname from an HTTP Host header. */
export function hostnameFromHostHeader(host: string | null) {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}
