import { afterEach, describe, expect, it, vi } from "vitest";
import { safeRemoteFetch } from "~/server/security/remote-url";
import { providerBytes, providerFetch, providerText } from "./http";

vi.mock("~/server/security/remote-url", () => ({
  safeRemoteFetch: vi.fn(),
}));

const fetchMock = vi.mocked(safeRemoteFetch);

afterEach(() => vi.resetAllMocks());

describe("provider HTTP safeguards", () => {
  it("rejects oversized binary content before buffering it", async () => {
    fetchMock.mockResolvedValue(
      new Response("not read", {
        headers: { "Content-Length": "2000001" },
      }),
    );

    await expect(
      providerBytes("github", "https://example.com/icon.png", {}),
    ).resolves.toBeUndefined();
  });

  it("rejects oversized source content before buffering it", async () => {
    fetchMock.mockResolvedValue(
      new Response("not read", {
        headers: { "Content-Length": "2000001" },
      }),
    );

    await expect(
      providerText("github", "https://example.com/large.ts", {}),
    ).resolves.toBeUndefined();
  });

  it("reports provider error responses", async () => {
    fetchMock.mockResolvedValue(new Response("denied", { status: 403 }));
    await expect(
      providerFetch("gitlab", "https://example.com/projects", {}),
    ).rejects.toThrow("403");
  });

  it("stops a GET retry loop when the caller aborts", async () => {
    fetchMock.mockResolvedValue(new Response("retry", { status: 503 }));
    const controller = new AbortController();

    const pending = providerFetch("github", "https://example.com/projects", {
      signal: controller.signal,
    });
    controller.abort(new Error("maintenance deadline reached"));

    await expect(pending).rejects.toThrow("maintenance deadline reached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose provider error bodies", async () => {
    fetchMock.mockResolvedValue(
      new Response("secret provider response", { status: 403 }),
    );
    await expect(
      providerFetch("github", "https://example.com/projects", {}),
    ).rejects.not.toThrow("secret provider response");
  });

  it("classifies GitHub primary rate limits from response headers", async () => {
    fetchMock.mockResolvedValue(
      new Response("API rate limit exceeded for a private account", {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0" },
      }),
    );

    await expect(
      providerFetch("github", "https://example.com/projects", {}),
    ).rejects.toThrow("rate limit exceeded");
  });

  it("classifies GitHub secondary rate limits without exposing the body", async () => {
    fetchMock.mockResolvedValue(
      new Response("You have exceeded a secondary rate limit", {
        status: 403,
        headers: { "Retry-After": "60" },
      }),
    );

    await expect(
      providerFetch("github", "https://example.com/projects", {}),
    ).rejects.toThrow("secondary rate limit exceeded");
  });

  it("classifies GitHub organization SSO authorization failures", async () => {
    fetchMock.mockResolvedValue(
      new Response("organization access denied", {
        status: 403,
        headers: { "X-GitHub-SSO": "required" },
      }),
    );

    await expect(
      providerFetch("github", "https://example.com/projects", {}),
    ).rejects.toThrow("single sign-on authorization required");
  });

  it("stops reading oversized streamed JSON responses", async () => {
    const oversized = new Uint8Array(5_100_000);
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.enqueue(oversized);
            controller.close();
          },
        }),
      ),
    );
    await expect(
      providerFetch("github", "https://example.com/projects", {}),
    ).rejects.toThrow("safe size limit");
  });

  it("identifies ReviewDuck on every provider request", async () => {
    fetchMock.mockResolvedValue(Response.json({ login: "reviewer" }));

    await providerFetch("github", "https://example.com/user", {});

    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("User-Agent")).toBe(
      "ReviewDuck.ai (+https://github.com/studie-tech/open-review-duck)",
    );
  });

  it("does not follow provider redirects to unvalidated hosts", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    await expect(
      providerFetch("github", "https://example.com/user", {}),
    ).rejects.toThrow("redirects are disabled");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/user",
      expect.objectContaining({ redirect: "manual" }),
      false,
    );
  });

  it("stops reading streamed source when it crosses the byte limit", async () => {
    const oversized = new Uint8Array(1_100_000);
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.enqueue(oversized);
            controller.close();
          },
        }),
      ),
    );

    await expect(
      providerText("azure_devops", "https://example.com/file.ts", {}),
    ).resolves.toBeUndefined();
  });
});
