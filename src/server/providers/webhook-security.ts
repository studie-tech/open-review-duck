import { createHmac, timingSafeEqual } from "node:crypto";

/** Compares authenticators without timing-dependent early exits. */
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verifies a GitHub App raw-body HMAC signature. */
export function verifyGitHubWebhook(
  secret: string,
  headers: Headers,
  body: Uint8Array,
) {
  const expected = `sha256=${createHmac("sha256", secret)
    .update(body)
    .digest("hex")}`;
  return safeEqual(headers.get("x-hub-signature-256") ?? "", expected);
}

/** Verifies GitLab's Standard Webhooks signature and freshness window. */
export function verifyGitLabWebhook(
  signingToken: string,
  headers: Headers,
  body: Uint8Array,
  now = Date.now(),
) {
  const messageId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (
    !signingToken.startsWith("whsec_") ||
    !messageId ||
    !timestamp ||
    !signatures ||
    !/^\d{1,12}$/.test(timestamp)
  ) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(now - timestampSeconds * 1_000) > 5 * 60_000
  ) {
    return false;
  }
  const key = Buffer.from(signingToken.slice("whsec_".length), "base64");
  if (key.byteLength !== 32) return false;
  const expected = `v1,${createHmac("sha256", key)
    .update(messageId)
    .update(".")
    .update(timestamp)
    .update(".")
    .update(body)
    .digest("base64")}`;
  return signatures
    .split(" ")
    .some((signature) => safeEqual(signature, expected));
}

/** Verifies Azure DevOps' per-hook HTTP Basic authenticator. */
export function verifyAzureWebhook(secret: string, headers: Headers) {
  return safeEqual(
    headers.get("authorization") ?? "",
    `Basic ${Buffer.from(`reviewduck:${secret}`).toString("base64")}`,
  );
}

/** Reads a request body without buffering beyond its hard byte limit. */
export async function boundedWebhookBody(
  request: Request,
  maximumBytes: number,
) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) return undefined;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
