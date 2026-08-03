import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundedWebhookBody,
  verifyAzureWebhook,
  verifyGitHubWebhook,
  verifyGitLabWebhook,
} from "./webhook-security";

const body = new TextEncoder().encode('{"pull_request":{"number":7}}');

describe("provider webhook verification", () => {
  it("verifies GitHub against the exact raw body", () => {
    const secret = "a-secure-github-webhook-secret";
    const headers = new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret)
        .update(body)
        .digest("hex")}`,
    });
    expect(verifyGitHubWebhook(secret, headers, body)).toBe(true);
    expect(
      verifyGitHubWebhook(
        secret,
        headers,
        new TextEncoder().encode("tampered"),
      ),
    ).toBe(false);
  });

  it("verifies a fresh GitLab Standard Webhook and rejects replay", () => {
    const now = 1_800_000_000_000;
    const timestamp = String(now / 1_000);
    const messageId = "delivery-id";
    const key = Buffer.alloc(32, 7);
    const token = `whsec_${key.toString("base64")}`;
    const signature = `v1,${createHmac("sha256", key)
      .update(`${messageId}.${timestamp}.`)
      .update(body)
      .digest("base64")}`;
    const headers = new Headers({
      "webhook-id": messageId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
    expect(verifyGitLabWebhook(token, headers, body, now)).toBe(true);
    expect(verifyGitLabWebhook(token, headers, body, now + 300_001)).toBe(
      false,
    );
    expect(
      verifyGitLabWebhook(
        token,
        headers,
        new TextEncoder().encode("tampered"),
        now,
      ),
    ).toBe(false);
  });

  it("verifies Azure DevOps against the per-hook Basic secret", () => {
    const secret = "azure-hook-secret";
    const headers = new Headers({
      authorization: `Basic ${Buffer.from(`reviewduck:${secret}`).toString("base64")}`,
    });
    expect(verifyAzureWebhook(secret, headers)).toBe(true);
    expect(verifyAzureWebhook("different", headers)).toBe(false);
  });

  it("stops reading once a chunked body exceeds its limit", async () => {
    const request = new Request("https://reviewduck.example/hook", {
      method: "POST",
      body: new Uint8Array(17),
    });
    await expect(boundedWebhookBody(request, 16)).resolves.toBeUndefined();
  });
});
