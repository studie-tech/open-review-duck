"use client";

import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  hydratePrivateReviewSources,
  type PrivateSourceHydrationFailure,
  type PrivateSourceRange,
} from "./private-source-client";

const EMPTY_RELATED_SOURCES: readonly never[] = [];

interface PrivateSourceHydrationOptions<
  Source extends PrivateSourceRange,
  RelatedSource extends PrivateSourceRange,
> {
  snapshotId?: string;
  sources: readonly Source[];
  hydrationSources?: readonly Source[];
  sourceKey: (source: Source) => string;
  sourceConcurrency?: number;
  relatedSources?: readonly RelatedSource[];
  relatedHydrationSources?: readonly RelatedSource[];
  relatedSourceKey?: (source: RelatedSource) => string;
  relatedConcurrency?: number;
  preserveSourceState?: (current: Source, hydrated: Source) => Source;
  onFailures?: (failures: readonly PrivateSourceHydrationFailure[]) => void;
}

interface PrivateSourceHydrationState<
  Source extends PrivateSourceRange,
  RelatedSource extends PrivateSourceRange,
> {
  sources: Source[];
  setSources: Dispatch<SetStateAction<Source[]>>;
  relatedSources: RelatedSource[];
  pending: boolean;
  successfulSourceKeys: ReadonlySet<string>;
  settledSourceKeys: ReadonlySet<string>;
}

interface ReviewSourceState {
  status: unknown;
  changedSinceSignOff: unknown;
  waitingSince: unknown;
}

/** Replaces hydrated source fields without reverting live review decisions. */
export function preservePrivateSourceReviewState<
  Source extends PrivateSourceRange & ReviewSourceState,
>(current: Source, hydrated: Source): Source {
  return {
    ...hydrated,
    status: current.status,
    changedSinceSignOff: current.changedSinceSignOff,
    waitingSince: current.waitingSince,
  };
}

/**
 * Hydrates an immutable private-source manifest for one snapshot.
 *
 * Primary and related sources share an abort signal and object cache. Source
 * replacements are coalesced into one animation-frame update, while callers
 * retain control of prioritization and any surface-specific state fields.
 */
export function usePrivateSourceHydration<
  Source extends PrivateSourceRange,
  RelatedSource extends PrivateSourceRange = Source,
>({
  snapshotId,
  sources,
  hydrationSources = sources,
  sourceKey,
  sourceConcurrency = 4,
  relatedSources = EMPTY_RELATED_SOURCES,
  relatedHydrationSources = relatedSources,
  relatedSourceKey,
  relatedConcurrency = 2,
  preserveSourceState,
  onFailures,
}: PrivateSourceHydrationOptions<
  Source,
  RelatedSource
>): PrivateSourceHydrationState<Source, RelatedSource> {
  const [hydratedSources, setHydratedSources] = useState(() => [...sources]);
  const [hydratedRelatedSources, setHydratedRelatedSources] = useState(() => [
    ...relatedSources,
  ]);
  const [pending, setPending] = useState(Boolean(snapshotId));
  const [successfulSourceKeys, setSuccessfulSourceKeys] = useState(
    () => new Set<string>(),
  );
  const [settledSourceKeys, setSettledSourceKeys] = useState(
    () => new Set<string>(),
  );

  // A snapshot is immutable. Object-identity-only query refreshes must not
  // replace its manifest and restart verified private-object downloads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot identity owns its immutable source manifest
  const manifest = useMemo(
    () => ({
      hydrationSources,
      relatedHydrationSources,
      relatedSources,
      sources,
    }),
    [snapshotId],
  );
  const optionsRef = useRef({
    onFailures,
    preserveSourceState,
    relatedSourceKey,
    sourceKey,
  });
  optionsRef.current = {
    onFailures,
    preserveSourceState,
    relatedSourceKey,
    sourceKey,
  };

  useEffect(() => {
    if (!snapshotId) return;
    let live = true;
    const controller = new AbortController();
    const cache = new Map<string, Promise<Uint8Array>>();
    const pendingSources = new Map<string, Source>();
    const pendingRelatedSources = new Map<string, RelatedSource>();
    const pendingSuccessfulKeys = new Set<string>();
    const pendingSettledKeys = new Set<string>();
    let flushFrame: number | undefined;

    setHydratedSources([...manifest.sources]);
    setHydratedRelatedSources([...manifest.relatedSources]);
    setSuccessfulSourceKeys(new Set());
    setSettledSourceKeys(new Set());
    setPending(true);

    /** Applies every source settled before the next paint in one update. */
    const flush = () => {
      flushFrame = undefined;
      if (!live) return;
      if (pendingSources.size > 0) {
        const replacements = new Map(pendingSources);
        pendingSources.clear();
        setHydratedSources((current) =>
          current.map((source) => {
            const replacement = replacements.get(
              optionsRef.current.sourceKey(source),
            );
            if (!replacement) return source;
            return (
              optionsRef.current.preserveSourceState?.(source, replacement) ??
              replacement
            );
          }),
        );
      }
      if (pendingRelatedSources.size > 0) {
        const replacements = new Map(pendingRelatedSources);
        pendingRelatedSources.clear();
        const relatedKey = optionsRef.current.relatedSourceKey;
        if (relatedKey) {
          setHydratedRelatedSources((current) =>
            current.map((source) => {
              const replacement = replacements.get(relatedKey(source));
              return replacement ?? source;
            }),
          );
        }
      }
      if (pendingSettledKeys.size > 0) {
        const settled = [...pendingSettledKeys];
        pendingSettledKeys.clear();
        setSettledSourceKeys((current) => new Set([...current, ...settled]));
      }
      if (pendingSuccessfulKeys.size > 0) {
        const successful = [...pendingSuccessfulKeys];
        pendingSuccessfulKeys.clear();
        setSuccessfulSourceKeys(
          (current) => new Set([...current, ...successful]),
        );
      }
    };
    /** Coalesces source callbacks behind the lifecycle's paint boundary. */
    const scheduleFlush = () => {
      flushFrame ??= window.requestAnimationFrame(flush);
    };

    const primary = hydratePrivateReviewSources(
      manifest.hydrationSources,
      snapshotId,
      cache,
      sourceConcurrency,
      controller.signal,
      (_index, hydrated) => {
        if (!live) return;
        const key = optionsRef.current.sourceKey(hydrated);
        pendingSources.set(key, hydrated);
        pendingSuccessfulKeys.add(key);
        pendingSettledKeys.add(key);
        scheduleFlush();
      },
      (_index, source) => {
        if (!live) return;
        pendingSettledKeys.add(optionsRef.current.sourceKey(source));
        scheduleFlush();
      },
    );
    const related: Promise<{
      failures: PrivateSourceHydrationFailure[];
    }> = optionsRef.current.relatedSourceKey
      ? hydratePrivateReviewSources(
          manifest.relatedHydrationSources,
          snapshotId,
          cache,
          relatedConcurrency,
          controller.signal,
          (_index, hydrated) => {
            if (!live) return;
            const key = optionsRef.current.relatedSourceKey?.(hydrated);
            if (!key) return;
            pendingRelatedSources.set(key, hydrated);
            scheduleFlush();
          },
        )
      : Promise.resolve({
          failures: [],
        });

    void Promise.all([primary, related])
      .then(([primaryResult, relatedResult]) => {
        if (!live) return;
        if (flushFrame !== undefined) window.cancelAnimationFrame(flushFrame);
        flush();
        const failures = [...primaryResult.failures, ...relatedResult.failures];
        if (failures.length > 0) optionsRef.current.onFailures?.(failures);
      })
      .catch((cause: unknown) => {
        if (!live || controller.signal.aborted) return;
        optionsRef.current.onFailures?.([{ cause, path: "" }]);
      })
      .finally(() => {
        if (live) setPending(false);
      });

    return () => {
      live = false;
      controller.abort();
      if (flushFrame !== undefined) window.cancelAnimationFrame(flushFrame);
      cache.clear();
    };
  }, [manifest, relatedConcurrency, snapshotId, sourceConcurrency]);

  return {
    pending,
    relatedSources: hydratedRelatedSources,
    setSources: setHydratedSources,
    settledSourceKeys,
    sources: hydratedSources,
    successfulSourceKeys,
  };
}
