const blockedProxyHeaders = new Set([
  "api-key",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-reviewduck-internal",
]);

/** Copies one end-to-end header only when it cannot alter proxy routing. */
export function setSafeProxyHeader(
  headers: Headers,
  name: string,
  value: string,
) {
  if (!blockedProxyHeaders.has(name.toLowerCase())) headers.set(name, value);
}
