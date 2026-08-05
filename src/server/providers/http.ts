import { safeRemoteFetch } from "~/server/security/remote-url";
import { ProviderError, type ProviderName } from "./types";

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_JSON_MAXIMUM_BYTES = 10_000_000;
export const PROVIDER_TEXT_MAXIMUM_BYTES = 2_000_000;
const PROVIDER_USER_AGENT =
  "ReviewDuck.ai (+https://github.com/studie-tech/open-review-duck)";

/** Performs a DNS-pinned provider request with a bounded lifetime. */
async function requestProvider(url: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", PROVIDER_USER_AGENT);
  }
  const method = (init.method ?? "GET").toUpperCase();
  const retryableMethod = method === "GET" || method === "HEAD";
  for (let attempt = 0; attempt < 3; attempt++) {
    const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    try {
      const response = await safeRemoteFetch(
        url,
        { ...init, headers, redirect: "manual", signal },
        process.env.ALLOW_PRIVATE_PROVIDER_HOSTS === "true",
      );
      if (
        !retryableMethod ||
        attempt === 2 ||
        ![408, 425, 429, 500, 502, 503, 504].includes(response.status)
      ) {
        return response;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      await retryDelay(
        Number.isFinite(retryAfter)
          ? Math.min(5_000, retryAfter * 1_000)
          : 100 * 2 ** attempt,
      );
    } catch (cause) {
      if (!retryableMethod || attempt === 2 || init.signal?.aborted)
        throw cause;
      await retryDelay(100 * 2 ** attempt);
    }
  }
  throw new Error("Provider retry loop ended unexpectedly");
}

/** Waits for one bounded exponential provider retry interval. */
function retryDelay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export interface ProviderResponse<T> {
  data: T;
  headers: Headers;
}

/** Classifies a provider failure without exposing its raw response body. */
async function providerFailureMessage(
  provider: ProviderName,
  response: Response,
) {
  const status = `${response.status} ${response.statusText}`.trim();
  const content = (await boundedResponseText(response, 16_000)) ?? "";
  const normalized = content.toLowerCase();
  if (response.status === 403 || response.status === 429) {
    if (
      response.headers.has("retry-after") ||
      normalized.includes("secondary rate limit") ||
      normalized.includes("abuse detection")
    ) {
      return `${status}: secondary rate limit exceeded`;
    }
    if (
      response.headers.get("x-ratelimit-remaining") === "0" ||
      normalized.includes("rate limit")
    ) {
      return `${status}: rate limit exceeded`;
    }
  }
  if (
    provider === "github" &&
    response.status === 403 &&
    (response.headers.has("x-github-sso") ||
      normalized.includes("single sign-on") ||
      normalized.includes("saml"))
  ) {
    return `${status}: organization single sign-on authorization required`;
  }
  return status;
}

/** Reads a response body without buffering more than the configured limit. */
async function boundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let content = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    content += decoder.decode(chunk.value, { stream: true });
  }
  return content + decoder.decode();
}

/** Maps values with a bounded number of concurrent asynchronous operations. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  /** Consumes the next item in a bounded-concurrency mapping operation. */
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await operation(item);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      worker,
    ),
  );
  return results;
}

/** Performs a provider request and returns the validated response. */
export async function providerResponse<T>(
  provider: ProviderName,
  url: string,
  init: RequestInit,
): Promise<ProviderResponse<T>> {
  const response = await requestProvider(url, init);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ProviderError(
      provider,
      "Provider redirects are disabled to prevent requests to unvalidated hosts",
      response.status,
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      provider,
      await providerFailureMessage(provider, response),
      response.status,
    );
  }
  const content = await boundedResponseText(
    response,
    PROVIDER_JSON_MAXIMUM_BYTES,
  );
  if (content === undefined) {
    throw new ProviderError(
      provider,
      "Provider response exceeded the safe size limit",
      response.status,
    );
  }
  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch (cause) {
    throw new ProviderError(
      provider,
      "Provider returned an invalid JSON response",
      response.status,
      { cause },
    );
  }
  return {
    data,
    headers: response.headers,
  };
}

/** Performs a provider request and parses its JSON body. */
export async function providerFetch<T>(
  provider: ProviderName,
  url: string,
  init: RequestInit,
): Promise<T> {
  return (await providerResponse<T>(provider, url, init)).data;
}

/** Performs a provider request whose successful response has no useful body. */
export async function providerVoid(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  acceptedStatuses: readonly number[] = [],
): Promise<void> {
  const response = await requestProvider(url, init);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ProviderError(
      provider,
      "Provider redirects are disabled to prevent requests to unvalidated hosts",
      response.status,
    );
  }
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new ProviderError(
      provider,
      await providerFailureMessage(provider, response),
      response.status,
    );
  }
  await response.body?.cancel();
}

/** Performs a provider request and returns its text body within the size limit. */
export async function providerText(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  maximumBytes = PROVIDER_TEXT_MAXIMUM_BYTES,
): Promise<string | undefined> {
  const response = await requestProvider(url, init);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ProviderError(
      provider,
      "Provider redirects are disabled to prevent requests to unvalidated hosts",
      response.status,
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      provider,
      await providerFailureMessage(provider, response),
      response.status,
    );
  }
  return boundedResponseText(response, maximumBytes);
}
