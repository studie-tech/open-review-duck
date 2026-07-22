export interface SessionTokenOptions {
  skipCache?: boolean;
}

export type SessionTokenGetter = (
  options?: SessionTokenOptions,
) => Promise<string | null>;

export interface AuthenticatedTransport {
  fetch: typeof fetch;
  refreshSession: () => Promise<string | null>;
}

/** Identifies an authentication failure without depending on tRPC client classes. */
export function isUnauthorizedError(error: unknown) {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return false;
  }
  const { data } = error;
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    data.code === "UNAUTHORIZED"
  );
}

/** Starts one forced refresh before retrying a rejected tRPC operation. */
export function refreshAuthenticationForRetry(
  attempts: number,
  error: unknown,
  refreshSession: () => Promise<string | null>,
) {
  if (attempts >= 2 || !isUnauthorizedError(error)) return false;
  void refreshSession();
  return true;
}

/** Reads a Clerk token without preventing the cookie-authenticated request. */
async function sessionToken(
  getToken: SessionTokenGetter,
  options?: SessionTokenOptions,
) {
  try {
    return await getToken(options);
  } catch {
    return null;
  }
}

/** Shares current and forced Clerk token reads across concurrent requests. */
export function createAuthenticatedTransport(
  getToken: SessionTokenGetter,
  fetcher: typeof fetch = globalThis.fetch,
): AuthenticatedTransport {
  let tokenRequest: Promise<string | null> | undefined;
  let refreshRequest: Promise<string | null> | undefined;

  /** Coalesces token reads so a burst of requests cannot race Clerk refreshes. */
  const readToken = (refresh = false) => {
    if (refresh) {
      refreshRequest ??= sessionToken(getToken, { skipCache: true }).finally(
        () => {
          refreshRequest = undefined;
        },
      );
      return refreshRequest;
    }
    if (refreshRequest) return refreshRequest;
    tokenRequest ??= sessionToken(getToken).finally(() => {
      tokenRequest = undefined;
    });
    return tokenRequest;
  };

  /** Sends authenticated requests and refreshes once after a raw HTTP 401. */
  const authenticatedFetch: typeof fetch = async (input, init) => {
    /** Sends one request with the selected bearer-token candidate. */
    const send = (token: string | null) => {
      const headers = new Headers(init?.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return fetcher(input, {
        ...init,
        credentials: "include",
        headers,
      });
    };

    const cachedToken = await readToken();
    const response = await send(cachedToken);
    if (response.status !== 401) return response;

    const refreshedToken = await readToken(true);
    return refreshedToken ? send(refreshedToken) : response;
  };

  return {
    fetch: authenticatedFetch,
    refreshSession: () => readToken(true),
  };
}

/** Adds current Clerk authentication and retries one HTTP rejection safely. */
export function createAuthenticatedFetch(
  getToken: SessionTokenGetter,
  fetcher: typeof fetch = globalThis.fetch,
): typeof fetch {
  return createAuthenticatedTransport(getToken, fetcher).fetch;
}
