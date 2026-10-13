export const PRIVATE_SOURCE_CONNECT_ORIGIN = "https://*.ufs.sh";
export const COMMENT_IMAGE_CSP_SOURCES = [
  "'self'",
  "blob:",
  "data:",
  "https:",
] as const;

/** Builds the nonce-based policy used by trusted local deployments. */
export function localContentSecurityPolicy(
  nonce: string,
  development: boolean,
) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // Provider origins can include self-hosted GitLab. The comment renderer
    // auto-loads only provider attachments and requires a click for other hosts.
    `img-src ${COMMENT_IMAGE_CSP_SOURCES.join(" ")}`,
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
