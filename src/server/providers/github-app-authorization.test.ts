import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  exchangeGitHubUserCode,
  githubAppPrivateKey,
  revokeGitHubUserToken,
  verifyGitHubInstallationOwnership,
} from "./github-app-authorization";

describe("GitHub App user authorization", () => {
  it("loads the PKCS#1 private-key format downloaded for GitHub Apps", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(githubAppPrivateKey(pem).asymmetricKeyType).toBe("rsa");
  });

  it("exchanges a code with PKCE without exposing credentials in the URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_verification" }), {
        status: 200,
      }),
    );
    await expect(
      exchangeGitHubUserCode(
        {
          clientId: "Iv1.client",
          clientSecret: "secret",
          code: "one-time-code",
          codeVerifier: "verifier",
          redirectUri: "https://reviewduck.example/github/complete",
        },
        fetcher,
      ),
    ).resolves.toBe("ghu_verification");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(String(init.body)).toContain("code_verifier=verifier");
    expect(String(init.body)).toContain(
      "redirect_uri=https%3A%2F%2Freviewduck.example%2Fgithub%2Fcomplete",
    );
    expect(String(url)).not.toContain("secret");
    expect(init.redirect).toBe("error");
  });

  it("fails closed when GitHub does not return a user token", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "bad_verification_code" })),
      );
    await expect(
      exchangeGitHubUserCode(
        {
          clientId: "client",
          clientSecret: "secret",
          code: "bad",
          codeVerifier: "verifier",
          redirectUri: "https://reviewduck.example/callback",
        },
        fetcher,
      ),
    ).rejects.toThrow("response is invalid");
  });

  it("accepts only an installation administered by the user token", async () => {
    const allowed = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/app/installations/")) {
        return Response.json({
          account: { id: 7, login: "acme", type: "Organization" },
        });
      }
      if (url.endsWith("/user")) return Response.json({ id: 9 });
      return Response.json({ role: "admin", state: "active" });
    });
    await expect(
      verifyGitHubInstallationOwnership(
        "42",
        "ghu_token",
        "app-token",
        allowed,
      ),
    ).resolves.toEqual({ accountId: "7", accountLogin: "acme" });
    expect(allowed).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/42",
      expect.objectContaining({ redirect: "error" }),
    );

    const denied = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/app/installations/")) {
        return Response.json({
          account: { id: 7, login: "acme", type: "Organization" },
        });
      }
      if (url.endsWith("/user")) return Response.json({ id: 9 });
      return Response.json({ role: "member", state: "active" });
    });
    await expect(
      verifyGitHubInstallationOwnership("43", "ghu_token", "app-token", denied),
    ).rejects.toThrow("not administered");
  });

  it("revokes the verification token with GitHub App credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await revokeGitHubUserToken(
      { clientId: "client", clientSecret: "secret", token: "ghu_token" },
      fetcher,
    );
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/applications/client/token");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client:secret").toString("base64")}`,
    );
    expect(init.body).toBe(JSON.stringify({ access_token: "ghu_token" }));
  });
});
