import { safeRemoteFetch } from "~/server/security/remote-url";
import { ProviderError, type ProviderName } from "./types";

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_JSON_MAXIMUM_BYTES = 10_000_000;
const PROVIDER_USER_AGENT =
  "ReviewDuck.ai (+https://github.com/studie-tech/open-review-duck)";

/** Performs a DNS-pinned provider request with a bounded lifetime. */
async function requestProvider(url: string, init: RequestInit) {
  const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", PROVIDER_USER_AGENT);
  }
  return safeRemoteFetch(
    url,
    { ...init, headers, redirect: "manual", signal },
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS === "true",
  );
}

export interface ProviderResponse<T> {
  data: T;
  headers: Headers;
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
    await boundedResponseText(response, 16_000);
    throw new ProviderError(
      provider,
      `${response.status} ${response.statusText}`.trim(),
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

/** Performs a provider request and returns its text body within the size limit. */
export async function providerText(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  maximumBytes = 2_000_000,
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
    await boundedResponseText(response, 16_000);
    throw new ProviderError(
      provider,
      `${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return boundedResponseText(response, maximumBytes);
}
