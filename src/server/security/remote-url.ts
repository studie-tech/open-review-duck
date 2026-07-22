import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const nonPublicAddresses = new BlockList();
const safeFetchPolicy = new AsyncLocalStorage<boolean>();
const nativeFetch = globalThis.fetch.bind(globalThis);
let safeFetchHookInstalled = false;

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

/** Checks whether an IP address is private, reserved, or otherwise non-public. */
export function isPrivateAddress(address: string) {
  const version = isIP(address);
  if (version === 0) return false;
  return nonPublicAddresses.check(address, version === 4 ? "ipv4" : "ipv6");
}

interface SafeRemoteTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** Resolves and validates a remote target immediately before it is contacted. */
export async function resolveSafeRemoteUrl(
  value: string,
  allowPrivateHosts: boolean,
  allowQuery = true,
): Promise<SafeRemoteTarget> {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("Remote URLs cannot contain credentials");
  }
  if ((!allowQuery && url.search) || url.hash) {
    throw new Error("Remote base URLs cannot contain a query or fragment");
  }
  if (url.protocol !== "https:" && !allowPrivateHosts) {
    throw new Error("Provider URLs must use HTTPS");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider URLs must use HTTP or HTTPS");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !allowPrivateHosts &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local"))
  ) {
    throw new Error("Private provider hosts are disabled");
  }

  const resolved = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error("Remote host did not resolve");
  if (
    !allowPrivateHosts &&
    resolved.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error("Private provider hosts are disabled");
  }

  const selected = resolved[0];
  if (!selected) throw new Error("Remote host did not resolve");
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

/** Validates a configurable provider base URL. */
export async function assertSafeRemoteUrl(
  value: string,
  allowPrivateHosts: boolean,
) {
  await resolveSafeRemoteUrl(value, allowPrivateHosts, false);
}

/**
 * Fetches a URL through a DNS-pinned socket. The original hostname remains in
 * the Host header and TLS SNI while the connection uses the vetted address.
 */
export async function safeRemoteFetch(
  value: string,
  init: RequestInit,
  allowPrivateHosts: boolean,
): Promise<Response> {
  const target = await resolveSafeRemoteUrl(value, allowPrivateHosts);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body =
    typeof init.body === "string" || init.body instanceof Uint8Array
      ? init.body
      : init.body === null || init.body === undefined
        ? undefined
        : (() => {
            throw new Error("Unsupported request body for a remote provider");
          })();
  /** Resolves the original hostname to the already-vetted socket address. */
  const lookupPinned: LookupFunction = (_hostname, options, callback) => {
    const wantsAll = typeof options === "object" && options.all;
    if (wantsAll) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };

  return new Promise<Response>((resolve, reject) => {
    const request = (
      target.url.protocol === "https:" ? httpsRequest : httpRequest
    )(
      target.url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: lookupPinned,
        signal: init.signal ?? undefined,
        servername:
          target.url.protocol === "https:" ? target.url.hostname : undefined,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, rawValue] of Object.entries(incoming.headers)) {
          for (const headerValue of Array.isArray(rawValue)
            ? rawValue
            : rawValue === undefined
              ? []
              : [rawValue]) {
            responseHeaders.append(name, headerValue);
          }
        }
        resolve(
          new Response(
            incoming.statusCode === 204 || init.method === "HEAD"
              ? null
              : (Readable.toWeb(incoming) as ReadableStream),
            {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

/** Installs a concurrency-safe fetch hook for SDKs that do not accept a transport. */
function installSafeFetchHook() {
  if (safeFetchHookInstalled) return;
  safeFetchHookInstalled = true;
  globalThis.fetch = async (input, init) => {
    const allowPrivateHosts = safeFetchPolicy.getStore();
    if (allowPrivateHosts === undefined) return nativeFetch(input, init);
    const request = input instanceof Request ? input : undefined;
    const method = init?.method ?? request?.method ?? "GET";
    const body = ["GET", "HEAD"].includes(method)
      ? undefined
      : (init?.body ??
        (request ? new Uint8Array(await request.arrayBuffer()) : undefined));
    return safeRemoteFetch(
      request?.url ?? String(input),
      {
        method,
        headers: init?.headers ?? request?.headers,
        body,
        signal: init?.signal ?? request?.signal,
      },
      allowPrivateHosts,
    );
  };
}

/** Runs an SDK operation with every nested fetch DNS-pinned and validated. */
export function withSafeRemoteFetch<T>(
  allowPrivateHosts: boolean,
  operation: () => Promise<T>,
) {
  installSafeFetchHook();
  return safeFetchPolicy.run(allowPrivateHosts, operation);
}
