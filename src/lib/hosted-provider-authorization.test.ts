import { afterEach, describe, expect, it, vi } from "vitest";
import { startHostedProviderAuthorization } from "./hosted-provider-authorization";

afterEach(() => vi.unstubAllGlobals());

describe("startHostedProviderAuthorization", () => {
  it("posts the exact provider and redirect payload before navigating", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ authorizationUrl: "https://github.com/login/oauth" }),
      );
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await startHostedProviderAuthorization(
      "github",
      "/review/pull-request-1",
      navigate,
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/github/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirectPath: "/review/pull-request-1" }),
    });
    expect(navigate).toHaveBeenCalledWith("https://github.com/login/oauth");
  });

  it("surfaces an error returned by a non-success response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "GitLab rejected the request" },
            { status: 403 },
          ),
        ),
    );

    await expect(
      startHostedProviderAuthorization(
        "gitlab",
        "/settings/providers",
        vi.fn(),
      ),
    ).rejects.toThrow("GitLab rejected the request");
  });

  it.each([
    { authorizationUrl: undefined },
    { authorizationUrl: "not a URL" },
    { authorizationUrl: "javascript:alert(1)" },
  ])(
    "rejects a malformed authorization URL: $authorizationUrl",
    async (payload) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));

      await expect(
        startHostedProviderAuthorization(
          "github",
          "/settings/providers",
          vi.fn(),
        ),
      ).rejects.toThrow("Authorization could not be started");
    },
  );

  it("uses the fallback error when the response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })),
    );

    await expect(
      startHostedProviderAuthorization(
        "github",
        "/settings/providers",
        vi.fn(),
      ),
    ).rejects.toThrow("Authorization could not be started");
  });
});
