export type DeploymentMode = "local" | "authenticated";

export const LOCAL_USER_ID = "reviewduck-local-user";

/** Returns whether a hostname is confined to the current machine. */
export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
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
