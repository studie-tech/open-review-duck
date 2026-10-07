/** Bounded, memory-only bytes owned by one mounted review workspace. */
export class VerifiedPrivateSourceCache {
  readonly #entries = new Map<string, Uint8Array>();
  #bytes = 0;
  /** Creates a cache with a fixed bound for this mounted workspace. */
  constructor(readonly maximumBytes = 20_000_000) {}

  /** Returns verified bytes and makes this object the most recently used entry. */
  get(blobId: string, digest: string) {
    const key = `${blobId}:${digest}`;
    const bytes = this.#entries.get(key);
    if (bytes) {
      this.#entries.delete(key);
      this.#entries.set(key, bytes);
    }
    return bytes;
  }

  /** Retains a verified object while evicting the oldest entries within the byte bound. */
  set(blobId: string, digest: string, bytes: Uint8Array) {
    if (bytes.byteLength > this.maximumBytes) return;
    const key = `${blobId}:${digest}`;
    this.#bytes -= this.#entries.get(key)?.byteLength ?? 0;
    this.#entries.delete(key);
    this.#entries.set(key, bytes);
    this.#bytes += bytes.byteLength;
    while (this.#bytes > this.maximumBytes || this.#entries.size > 48) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#bytes -= this.#entries.get(oldest)?.byteLength ?? 0;
      this.#entries.delete(oldest);
    }
  }
}

export interface PrivateSourceRange {
  currentBlobId: string | null;
  previousBlobId: string | null;
  startByte: number;
  endByte: number;
  previousStartByte: number | null;
  previousEndByte: number | null;
  path: string;
}

export interface PrivateSourceHydrationFailure {
  cause: unknown;
  path: string;
}

interface SourcePriority {
  activeId?: string;
  activePath?: string;
  relatedIds?: ReadonlySet<string>;
  relatedPaths?: ReadonlySet<string>;
}

/** Orders private source work around the review concept already on screen. */
export function prioritizePrivateReviewSources<
  Source extends { id?: string; path: string },
>(sources: readonly Source[], priority: SourcePriority) {
  /** Gives visible work a lower rank while preserving canonical order. */
  const rank = (source: Source) => {
    if (source.id && source.id === priority.activeId) return 0;
    if (source.id && priority.relatedIds?.has(source.id)) return 1;
    if (source.path === priority.activePath) return 2;
    if (priority.relatedPaths?.has(source.path)) return 3;
    return 4;
  };
  return sources
    .map((source, index) => ({ index, rank: rank(source), source }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ source }) => source);
}

/** Encodes digest bytes using lowercase hexadecimal. */
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Reads the hexadecimal digest stated by a `sha-256=` response header. */
function statedDigest(header: string) {
  const encoded = header.startsWith("sha-256=")
    ? atob(header.slice("sha-256=".length))
    : "";
  if (!encoded) throw new Error("Private source digest header is invalid");
  return [...encoded]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

/** Accepts downloaded bytes only when they hash to the digest claimed for them. */
async function verified(bytes: ArrayBuffer, digest: string) {
  if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== digest) {
    throw new Error("Private source digest verification failed");
  }
  return new Uint8Array(bytes);
}

/** Downloads one authorized private object directly and verifies its digest. */
async function privateObject(
  blobId: string,
  snapshotId: string,
  path: string,
  signal?: AbortSignal,
  reusable?: VerifiedPrivateSourceCache,
) {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const access = await fetch(
    `/api/source/${encodeURIComponent(blobId)}?snapshotId=${encodeURIComponent(snapshotId)}&path=${encodeURIComponent(path)}`,
    { cache: "no-store", credentials: "same-origin", signal: requestSignal },
  );
  if (!access.ok) throw new Error("Private source authorization failed");
  // A self-hosted installation keeps objects on its own disk, so it answers
  // with the bytes themselves rather than a URL into a private object store.
  const digestHeader = access.headers.get("Digest");
  if (digestHeader) {
    return verified(await access.arrayBuffer(), statedDigest(digestHeader));
  }
  const metadata = (await access.json()) as {
    digest?: unknown;
    signedUrl?: unknown;
  };
  if (
    typeof metadata.digest !== "string" ||
    typeof metadata.signedUrl !== "string"
  ) {
    throw new Error("Private source authorization response is invalid");
  }
  // Authorization is checked again for this snapshot before any memory hit.
  // Only bytes survive a revision change; signed URLs never enter this cache.
  const cached = reusable?.get(blobId, metadata.digest);
  if (cached) return cached;
  const response = await fetch(metadata.signedUrl, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: requestSignal,
  });
  if (!response.ok) throw new Error("Private source download failed");
  const bytes = await verified(await response.arrayBuffer(), metadata.digest);
  reusable?.set(blobId, metadata.digest, bytes);
  return bytes;
}

/** Decodes one validated UTF-8 byte range. */
function decode(bytes: Uint8Array, start: number, end: number) {
  if (start < 0 || end < start || end > bytes.byteLength) {
    throw new Error("Private source range is invalid");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(start, end),
  );
}

/** Hydrates one review unit without retaining its signed URL. */
async function hydratePrivateReviewSource<Unit extends PrivateSourceRange>(
  unit: Unit,
  snapshotId: string,
  cache: Map<string, Promise<Uint8Array>>,
  signal?: AbortSignal,
  reusable?: VerifiedPrivateSourceCache,
) {
  /** Deduplicates downloads while hydrating related review units. */
  const load = (blobId: string) => {
    let pending = cache.get(blobId);
    if (!pending) {
      pending = privateObject(blobId, snapshotId, unit.path, signal, reusable);
      cache.set(blobId, pending);
    }
    return pending;
  };
  const [current, previous] = await Promise.all([
    unit.currentBlobId ? load(unit.currentBlobId) : undefined,
    unit.previousBlobId ? load(unit.previousBlobId) : undefined,
  ]);
  return {
    ...unit,
    source: current ? decode(current, unit.startByte, unit.endByte) : "",
    previousSource:
      previous &&
      unit.previousStartByte !== null &&
      unit.previousEndByte !== null
        ? decode(previous, unit.previousStartByte, unit.previousEndByte)
        : null,
  };
}

/** Hydrates private ranges with bounded concurrency and per-unit degradation. */
export async function hydratePrivateReviewSources<
  Unit extends PrivateSourceRange,
>(
  units: readonly Unit[],
  snapshotId: string,
  cache: Map<string, Promise<Uint8Array>>,
  concurrency = 4,
  signal?: AbortSignal,
  onUnitHydrated?: (index: number, unit: Unit) => void,
  onUnitFailed?: (index: number, unit: Unit, cause: unknown) => void,
  reusable?: VerifiedPrivateSourceCache,
) {
  const hydrated = new Array<Unit>(units.length);
  const failures: PrivateSourceHydrationFailure[] = [];
  const successfulIndexes: number[] = [];
  let nextIndex = 0;
  /** Claims and hydrates units until the shared work list is exhausted. */
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = nextIndex++;
      const unit = units[index];
      if (!unit) return;
      try {
        hydrated[index] = await hydratePrivateReviewSource(
          unit,
          snapshotId,
          cache,
          signal,
          reusable,
        );
        successfulIndexes.push(index);
        onUnitHydrated?.(index, hydrated[index]);
      } catch (cause) {
        if (signal?.aborted) return;
        hydrated[index] = unit;
        failures.push({ cause, path: unit.path });
        onUnitFailed?.(index, unit, cause);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), units.length) },
      worker,
    ),
  );
  if (signal?.aborted) {
    for (const [index, unit] of units.entries()) {
      hydrated[index] ??= unit;
    }
  }
  return { failures, successfulIndexes, units: hydrated };
}
