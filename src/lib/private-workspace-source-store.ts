import {
  hydratePrivateReviewSources,
  type PrivateSourceRange,
} from "./private-source-client";

export type WorkspaceSourcePriority = "active" | "next" | "preview";
export type WorkspaceSourceStatus =
  | "idle"
  | "queued"
  | "loading"
  | "ready"
  | "error";

interface WorkspaceSourceUnit extends PrivateSourceRange {
  id: string;
  kind: string;
}

interface WorkspaceFileContext extends PrivateSourceRange {}

export interface WorkspaceSourceResult<
  Unit extends WorkspaceSourceUnit,
  Context extends WorkspaceFileContext,
> {
  context?: Context;
  units: Unit[];
}

interface SourceRequest<
  Unit extends WorkspaceSourceUnit,
  Context extends WorkspaceFileContext,
> {
  path: string;
  priority: WorkspaceSourcePriority;
  queuedAt: number;
  sequence: number;
  resolve: (result: WorkspaceSourceResult<Unit, Context>) => void;
  reject: (cause: unknown) => void;
  promise: Promise<WorkspaceSourceResult<Unit, Context>>;
}

type HydrateSources = typeof hydratePrivateReviewSources;

export interface WorkspaceSourceMeasurement {
  loadMilliseconds: number;
  priority: WorkspaceSourcePriority;
  queueMilliseconds: number;
  status: "ready" | "error";
  totalMilliseconds: number;
}

const PRIORITY_RANK: Record<WorkspaceSourcePriority, number> = {
  active: 0,
  next: 1,
  preview: 2,
};

/**
 * Loads private review source at file granularity through a mutable priority queue.
 *
 * The object cache remains stable for the lifetime of one immutable snapshot,
 * while queued paths can be promoted whenever navigation intent changes. One
 * file task downloads its complete current/previous objects before deriving all
 * of the file's review-unit slices from those already verified bytes.
 */
export class PrivateWorkspaceSourceStore<
  Unit extends WorkspaceSourceUnit,
  Context extends WorkspaceFileContext,
> {
  readonly #snapshotId: string;
  readonly #unitsByPath: ReadonlyMap<string, readonly Unit[]>;
  readonly #contextByPath: ReadonlyMap<string, Context>;
  readonly #hydrate: HydrateSources;
  readonly #concurrency: number;
  readonly #maximumReadyFiles: number;
  readonly #onFailure?: (cause: unknown) => void;
  readonly #onMeasurement?: (measurement: WorkspaceSourceMeasurement) => void;
  readonly #controller = new AbortController();
  readonly #blobCache = new Map<string, Promise<Uint8Array>>();
  readonly #requests = new Map<string, SourceRequest<Unit, Context>>();
  readonly #results = new Map<string, WorkspaceSourceResult<Unit, Context>>();
  readonly #errors = new Map<string, unknown>();
  readonly #statuses = new Map<string, WorkspaceSourceStatus>();
  readonly #listeners = new Set<() => void>();
  #queue: Array<SourceRequest<Unit, Context>> = [];
  #active = 0;
  #sequence = 0;
  #revision = 0;
  #retainers = 0;
  #disposed = false;

  /** Creates one snapshot-scoped, file-granular source store. */
  constructor(input: {
    snapshotId: string;
    units: readonly Unit[];
    contexts: readonly Context[];
    concurrency?: number;
    maximumReadyFiles?: number;
    hydrate?: HydrateSources;
    onFailure?: (cause: unknown) => void;
    onMeasurement?: (measurement: WorkspaceSourceMeasurement) => void;
  }) {
    this.#snapshotId = input.snapshotId;
    this.#hydrate = input.hydrate ?? hydratePrivateReviewSources;
    this.#concurrency = Math.max(1, input.concurrency ?? 4);
    this.#maximumReadyFiles = Math.max(1, input.maximumReadyFiles ?? 24);
    this.#onFailure = input.onFailure;
    this.#onMeasurement = input.onMeasurement;
    const unitsByPath = new Map<string, Unit[]>();
    for (const unit of input.units) {
      const existing = unitsByPath.get(unit.path);
      if (existing) existing.push(unit);
      else unitsByPath.set(unit.path, [unit]);
    }
    this.#unitsByPath = unitsByPath;
    this.#contextByPath = new Map(
      input.contexts.map((context) => [context.path, context]),
    );
  }

  /** Subscribes React or a test harness to source-state changes. */
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Returns a monotonic snapshot suitable for `useSyncExternalStore`. */
  revision = () => this.#revision;

  /** Retains the store across React effect replay and releases it on unmount. */
  retain = () => {
    if (this.#disposed) {
      throw new DOMException("Source store disposed", "AbortError");
    }
    this.#retainers += 1;
    let released = false;
    /** Releases this owner and disposes after synchronous effect replay settles. */
    return () => {
      if (released) return;
      released = true;
      this.#retainers = Math.max(0, this.#retainers - 1);
      queueMicrotask(() => {
        if (this.#retainers === 0) this.dispose();
      });
    };
  };

  /** Reads one path's current lifecycle state. */
  status(path: string | undefined): WorkspaceSourceStatus {
    if (!path) return "idle";
    return this.#statuses.get(path) ?? "idle";
  }

  /** Reads one successfully materialized file without changing its priority. */
  result(path: string): WorkspaceSourceResult<Unit, Context> | undefined {
    return this.#results.get(path);
  }

  /** Reads the failure retained for an explicitly retryable path. */
  error(path: string): unknown {
    return this.#errors.get(path);
  }

  /**
   * Ensures a file is loaded and promotes queued work when intent becomes nearer.
   */
  request(
    path: string,
    priority: WorkspaceSourcePriority,
  ): Promise<WorkspaceSourceResult<Unit, Context>> {
    if (this.#disposed) {
      return Promise.reject(
        new DOMException("Source store disposed", "AbortError"),
      );
    }
    const ready = this.#results.get(path);
    if (ready) {
      // Map insertion order is the LRU ledger. A read makes this file newest.
      this.#results.delete(path);
      this.#results.set(path, ready);
      return Promise.resolve(ready);
    }
    const existing = this.#requests.get(path);
    if (existing) {
      if (PRIORITY_RANK[priority] < PRIORITY_RANK[existing.priority]) {
        existing.priority = priority;
        if (this.status(path) === "queued") this.#sortQueue();
        this.#publish();
      }
      return existing.promise;
    }
    if (!this.#unitsByPath.has(path) && !this.#contextByPath.has(path)) {
      return Promise.reject(new Error(`Unknown review source path: ${path}`));
    }

    let resolve!: SourceRequest<Unit, Context>["resolve"];
    let reject!: SourceRequest<Unit, Context>["reject"];
    const promise = new Promise<WorkspaceSourceResult<Unit, Context>>(
      (onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      },
    );
    const request: SourceRequest<Unit, Context> = {
      path,
      priority,
      queuedAt: performance.now(),
      sequence: this.#sequence++,
      resolve,
      reject,
      promise,
    };
    this.#requests.set(path, request);
    this.#statuses.set(path, "queued");
    this.#queue.push(request);
    this.#sortQueue();
    this.#publish();
    this.#pump();
    return promise;
  }

  /** Drops one failed path and its failed object promises before trying again. */
  retry(
    path: string,
    priority: WorkspaceSourcePriority = "active",
  ): Promise<WorkspaceSourceResult<Unit, Context>> {
    if (this.status(path) !== "error") return this.request(path, priority);
    for (const source of [
      ...(this.#unitsByPath.get(path) ?? []),
      this.#contextByPath.get(path),
    ]) {
      if (!source) continue;
      if (source.currentBlobId) this.#blobCache.delete(source.currentBlobId);
      if (source.previousBlobId) this.#blobCache.delete(source.previousBlobId);
    }
    this.#requests.delete(path);
    this.#results.delete(path);
    this.#errors.delete(path);
    this.#statuses.delete(path);
    this.#publish();
    return this.request(path, priority);
  }

  /** Aborts in-flight work and releases source bytes when the snapshot unmounts. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller.abort();
    const cause = new DOMException("Source store disposed", "AbortError");
    for (const request of this.#requests.values()) request.reject(cause);
    this.#queue = [];
    this.#requests.clear();
    this.#results.clear();
    this.#errors.clear();
    this.#statuses.clear();
    this.#blobCache.clear();
    this.#publish();
    this.#listeners.clear();
  }

  /** Orders only work that has not started; active requests are never restarted. */
  #sortQueue() {
    this.#queue.sort(
      (left, right) =>
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
        left.sequence - right.sequence,
    );
  }

  /** Fills the bounded file-level worker pool. */
  #pump() {
    while (!this.#disposed && this.#active < this.#concurrency) {
      const request = this.#queue.shift();
      if (!request) return;
      const startedAt = performance.now();
      this.#active += 1;
      this.#statuses.set(request.path, "loading");
      this.#publish();
      void this.#loadPath(request.path)
        .then((result) => {
          if (this.#disposed) return;
          this.#results.set(request.path, result);
          this.#evictLeastRecentlyUsed(request.path);
          this.#errors.delete(request.path);
          this.#statuses.set(request.path, "ready");
          this.#measure(request, startedAt, "ready");
          request.resolve(result);
        })
        .catch((cause: unknown) => {
          if (this.#disposed || this.#controller.signal.aborted) return;
          this.#errors.set(request.path, cause);
          this.#statuses.set(request.path, "error");
          this.#onFailure?.(cause);
          this.#measure(request, startedAt, "error");
          request.reject(cause);
        })
        .finally(() => {
          this.#requests.delete(request.path);
          this.#active -= 1;
          this.#publish();
          this.#pump();
        });
    }
  }

  /** Loads a complete file first, then derives all atomic ranges from its cache. */
  async #loadPath(path: string): Promise<WorkspaceSourceResult<Unit, Context>> {
    const context = this.#contextByPath.get(path);
    let hydratedContext: Context | undefined;
    if (context) {
      const contextResult = await this.#hydrate(
        [context],
        this.#snapshotId,
        this.#blobCache,
        1,
        this.#controller.signal,
      );
      if (contextResult.failures[0]) throw contextResult.failures[0].cause;
      hydratedContext = contextResult.units[0];
    }
    const units = [...(this.#unitsByPath.get(path) ?? [])];
    const unitResult = await this.#hydrate(
      units,
      this.#snapshotId,
      this.#blobCache,
      Math.max(1, Math.min(8, units.length)),
      this.#controller.signal,
    );
    if (unitResult.failures[0]) throw unitResult.failures[0].cause;
    return { context: hydratedContext, units: unitResult.units };
  }

  /** Bounds decoded source and verified bytes while protecting the newest file. */
  #evictLeastRecentlyUsed(newestPath: string) {
    while (this.#results.size > this.#maximumReadyFiles) {
      const oldestPath = this.#results.keys().next().value as
        | string
        | undefined;
      if (!oldestPath) return;
      if (oldestPath === newestPath && this.#results.size === 1) return;
      this.#results.delete(oldestPath);
      this.#statuses.delete(oldestPath);
      for (const source of [
        ...(this.#unitsByPath.get(oldestPath) ?? []),
        this.#contextByPath.get(oldestPath),
      ]) {
        if (!source) continue;
        if (source.currentBlobId) this.#blobCache.delete(source.currentBlobId);
        if (source.previousBlobId)
          this.#blobCache.delete(source.previousBlobId);
      }
    }
  }

  /** Reports privacy-safe queue and load timing without source identity. */
  #measure(
    request: SourceRequest<Unit, Context>,
    startedAt: number,
    status: WorkspaceSourceMeasurement["status"],
  ) {
    const completedAt = performance.now();
    this.#onMeasurement?.({
      loadMilliseconds: completedAt - startedAt,
      priority: request.priority,
      queueMilliseconds: startedAt - request.queuedAt,
      status,
      totalMilliseconds: completedAt - request.queuedAt,
    });
  }

  /** Publishes a new immutable revision to subscribed React consumers. */
  #publish() {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}
