import "server-only";

import type { UnimportedPullRequest } from "~/lib/unimported-pull-requests";

interface InboxDiscoveryResult {
  pullRequests: UnimportedPullRequest[];
  errors: Array<{
    message: string;
    repositoryId: string;
    repositoryName: string;
    repositoryOwner: string;
  }>;
  repositoryCount: number;
  mergeConflictKeys: string[];
}

interface CachedInboxRead {
  expiresAt: number;
  read: Promise<InboxDiscoveryResult>;
}

const caches = new WeakMap<object, Map<string, CachedInboxRead>>();
const CACHE_DURATION_MS = 5_000;
const MAX_CACHED_INBOXES = 100;

/** Reuses concurrent and burst inbox reads within one authenticated scope. */
export function cachedInboxDiscovery(
  database: object,
  workspaceId: string,
  userId: string,
  load: () => Promise<InboxDiscoveryResult>,
) {
  let cache = caches.get(database);
  if (!cache) {
    cache = new Map();
    caches.set(database, cache);
  }
  const scope = JSON.stringify([workspaceId, userId]);
  const existing = cache.get(scope);
  if (existing && existing.expiresAt > Date.now()) return existing.read;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= Date.now()) cache.delete(key);
  }
  if (cache.size >= MAX_CACHED_INBOXES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const entry: CachedInboxRead = {
    expiresAt: Number.POSITIVE_INFINITY,
    read: Promise.resolve().then(load),
  };
  cache.set(scope, entry);
  const scopedCache = cache;
  void entry.read.then(
    (result) => {
      if (result.errors.length === 0) {
        entry.expiresAt = Date.now() + CACHE_DURATION_MS;
      } else if (scopedCache.get(scope) === entry) {
        scopedCache.delete(scope);
      }
    },
    () => {
      if (scopedCache.get(scope) === entry) scopedCache.delete(scope);
    },
  );
  return entry.read;
}
