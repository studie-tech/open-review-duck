interface SourceRange {
  currentBlobId: string | null;
  previousBlobId: string | null;
  startByte: number;
  endByte: number;
  previousStartByte: number | null;
  previousEndByte: number | null;
  path: string;
}

/** Encodes digest bytes using lowercase hexadecimal. */
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Downloads one authorized private object directly and verifies its digest. */
async function privateObject(
  blobId: string,
  snapshotId: string,
  path: string,
  signal?: AbortSignal,
) {
  const access = await fetch(
    `/api/source/${encodeURIComponent(blobId)}?snapshotId=${encodeURIComponent(snapshotId)}&path=${encodeURIComponent(path)}`,
    { cache: "no-store", credentials: "same-origin", signal },
  );
  if (!access.ok) throw new Error("Private source authorization failed");
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
  const response = await fetch(metadata.signedUrl, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error("Private source download failed");
  const bytes = await response.arrayBuffer();
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== metadata.digest) {
    throw new Error("Private source digest verification failed");
  }
  return new Uint8Array(bytes);
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
async function hydratePrivateReviewSource<Unit extends SourceRange>(
  unit: Unit,
  snapshotId: string,
  cache: Map<string, Promise<Uint8Array>>,
  signal?: AbortSignal,
) {
  /** Deduplicates downloads while hydrating related review units. */
  const load = (blobId: string) => {
    let pending = cache.get(blobId);
    if (!pending) {
      pending = privateObject(blobId, snapshotId, unit.path, signal);
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
export async function hydratePrivateReviewSources<Unit extends SourceRange>(
  units: readonly Unit[],
  snapshotId: string,
  cache: Map<string, Promise<Uint8Array>>,
  concurrency = 4,
  signal?: AbortSignal,
  onUnitHydrated?: (index: number, unit: Unit) => void,
) {
  const hydrated = new Array<Unit>(units.length);
  const failures: Array<{ cause: unknown; path: string }> = [];
  const successfulIndexes: number[] = [];
  let nextIndex = 0;
  /** Claims and hydrates units until the shared work list is exhausted. */
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      const unit = units[index];
      if (!unit) return;
      try {
        hydrated[index] = await hydratePrivateReviewSource(
          unit,
          snapshotId,
          cache,
          signal,
        );
        successfulIndexes.push(index);
        onUnitHydrated?.(index, hydrated[index]);
      } catch (cause) {
        hydrated[index] = unit;
        failures.push({ cause, path: unit.path });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), units.length) },
      worker,
    ),
  );
  return { failures, successfulIndexes, units: hydrated };
}
