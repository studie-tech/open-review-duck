import { describe, expect, it, vi } from "vitest";
import {
  createAuthenticatedFetch,
  createAuthenticatedTransport,
  isUnauthorizedError,
  refreshAuthenticationForRetry,
} from "./authenticated-fetch";

/** Reads normalized headers from a mocked fetch invocation. */
function requestHeaders(fetcher: ReturnType<typeof vi.fn>, call: number) {
  const init = fetcher.mock.calls[call]?.[1] as RequestInit | undefined;
  return {
    credentials: init?.credentials,
    headers: new Headers(init?.headers),
  };
}

describe("authenticated tRPC fetch", () => {
  it("sends both the current Clerk token and same-origin cookies", async () => {
    const getToken = vi.fn().mockResolvedValue("current-token");
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));

    await createAuthenticatedFetch(getToken, fetcher)("/api/trpc", {
      headers: { "x-trpc-source": "test" },
    });

    expect(getToken).toHaveBeenCalledOnce();
    expect(requestHeaders(fetcher, 0).credentials).toBe("include");
    expect(requestHeaders(fetcher, 0).headers.get("authorization")).toBe(
      "Bearer current-token",
    );
    expect(requestHeaders(fetcher, 0).headers.get("x-trpc-source")).toBe(
      "test",
    );
  });

  it("refreshes a rejected token and retries exactly once", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce("fresh-token");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const response = await createAuthenticatedFetch(
      getToken,
      fetcher,
    )("/api/trpc");

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(requestHeaders(fetcher, 1).headers.get("authorization")).toBe(
      "Bearer fresh-token",
    );
  });

  it("falls back to cookie authentication when Clerk cannot return a token", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("offline"));
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));

    await createAuthenticatedFetch(getToken, fetcher)("/api/trpc");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestHeaders(fetcher, 0).credentials).toBe("include");
    expect(requestHeaders(fetcher, 0).headers.has("authorization")).toBe(false);
  });

  it("coalesces concurrent token reads during a request burst", async () => {
    const getToken = vi.fn().mockResolvedValue("current-token");
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const authenticatedFetch = createAuthenticatedFetch(getToken, fetcher);

    await Promise.all([
      authenticatedFetch("/api/trpc?request=1"),
      authenticatedFetch("/api/trpc?request=2"),
      authenticatedFetch("/api/trpc?request=3"),
    ]);

    expect(getToken).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (let call = 0; call < 3; call += 1) {
      expect(requestHeaders(fetcher, call).headers.get("authorization")).toBe(
        "Bearer current-token",
      );
    }
  });

  it("coalesces concurrent forced refreshes after rejected requests", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce("fresh-token");
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(null, {
          status:
            new Headers(init?.headers).get("authorization") ===
            "Bearer fresh-token"
              ? 200
              : 401,
        }),
    );
    const authenticatedFetch = createAuthenticatedFetch(getToken, fetcher);

    const responses = await Promise.all([
      authenticatedFetch("/api/trpc?request=1"),
      authenticatedFetch("/api/trpc?request=2"),
      authenticatedFetch("/api/trpc?request=3"),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenLastCalledWith({ skipCache: true });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("shares an explicit tRPC refresh with requests retried after an embedded error", async () => {
    let completeRefresh: ((token: string) => void) | undefined;
    const getToken = vi
      .fn()
      .mockResolvedValueOnce("expired-token")
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            completeRefresh = resolve;
          }),
      );
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const transport = createAuthenticatedTransport(getToken, fetcher);

    await transport.fetch("/api/trpc?request=initial");
    const refresh = transport.refreshSession();
    const retry = transport.fetch("/api/trpc?request=retry");
    completeRefresh?.("fresh-token");

    await Promise.all([refresh, retry]);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenLastCalledWith({ skipCache: true });
    expect(requestHeaders(fetcher, 1).headers.get("authorization")).toBe(
      "Bearer fresh-token",
    );
  });

  it("recognizes only structured tRPC authentication errors", () => {
    expect(isUnauthorizedError({ data: { code: "UNAUTHORIZED" } })).toBe(true);
    expect(isUnauthorizedError({ data: { code: "NOT_FOUND" } })).toBe(false);
    expect(isUnauthorizedError(new Error("UNAUTHORIZED"))).toBe(false);
  });

  it("refreshes once before retrying an unauthorized tRPC operation", () => {
    const refreshSession = vi.fn().mockResolvedValue("fresh-token");
    const unauthorized = { data: { code: "UNAUTHORIZED" } };

    expect(refreshAuthenticationForRetry(1, unauthorized, refreshSession)).toBe(
      true,
    );
    expect(refreshAuthenticationForRetry(2, unauthorized, refreshSession)).toBe(
      false,
    );
    expect(
      refreshAuthenticationForRetry(
        1,
        { data: { code: "NOT_FOUND" } },
        refreshSession,
      ),
    ).toBe(false);
    expect(refreshSession).toHaveBeenCalledOnce();
  });
});
