export type HostedAuthorizationProvider = "github" | "gitlab";

const authorizationStartError = "Authorization could not be started";

/** Starts a hosted provider authorization flow and redirects to the provider. */
export async function startHostedProviderAuthorization(
  provider: HostedAuthorizationProvider,
  redirectPath: string,
  navigate: (authorizationUrl: string) => void = (authorizationUrl) =>
    window.location.assign(authorizationUrl),
) {
  const response = await fetch(`/api/integrations/${provider}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirectPath }),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(authorizationStartError);
  }

  const result =
    typeof payload === "object" && payload !== null
      ? (payload as { authorizationUrl?: unknown; error?: unknown })
      : undefined;
  if (!response.ok) {
    throw new Error(
      typeof result?.error === "string" && result.error.trim()
        ? result.error
        : authorizationStartError,
    );
  }
  if (
    typeof result?.authorizationUrl !== "string" ||
    !isHttpUrl(result.authorizationUrl)
  ) {
    throw new Error(authorizationStartError);
  }

  navigate(result.authorizationUrl);
}

/** Returns whether a provider response contains a safe HTTP redirect URL. */
function isHttpUrl(value: string) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
