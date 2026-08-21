"use client";

import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  GitBranch,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { LinkPendingSpinner } from "~/components/ui/link-status";
import { hydratePrivateReviewSources } from "~/lib/private-source-client";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Workspace = RouterOutputs["review"]["workspace"];
type Monitor = RouterOutputs["repoReviews"]["list"][number];

/** Converts a unit source range into numbered display rows. */
function sourceLines(source: string, startLine: number) {
  return source.split("\n").map((content, index) => ({
    number: startLine + index,
    content,
  }));
}

/** Finds the old revision's first line when a symbol moved between snapshots. */
function previousStartLine(unit: Workspace["units"][number] | undefined) {
  const starts =
    unit?.relatedRanges
      ?.map(({ previousStartLine }) => previousStartLine)
      .filter((line): line is number => line !== undefined) ?? [];
  return starts.length > 0 ? Math.min(...starts) : (unit?.startLine ?? 1);
}

/** Focused repository reader: path, source, and one clear completion action. */
export function RepositoryReader({
  initialData,
  monitor,
}: {
  initialData: Workspace;
  monitor: Monitor;
}) {
  const [units, setUnits] = useState(initialData.units);
  const [activeId, setActiveId] = useState(
    initialData.units.find(({ status }) => status !== "signed_off")?.id ??
      initialData.units[0]?.id,
  );
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previousUnitId, setPreviousUnitId] = useState<string>();
  const [sourceLoading, setSourceLoading] = useState(
    initialData.sourceDelivery === "direct" && Boolean(initialData.snapshot),
  );
  const activeIndex = Math.max(
    0,
    units.findIndex(({ id }) => id === activeId),
  );
  const active = units[activeIndex];

  useEffect(() => {
    if (initialData.sourceDelivery !== "direct" || !initialData.snapshot)
      return;
    let live = true;
    const controller = new AbortController();
    const cache = new Map<string, Promise<Uint8Array>>();
    const hydratedById = new Map<string, Workspace["units"][number]>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    /** Applies all source files hydrated in the same event-loop turn at once. */
    const flushHydrated = () => {
      flushTimer = undefined;
      if (!live || hydratedById.size === 0) return;
      const hydrated = new Map(hydratedById);
      hydratedById.clear();
      setUnits((current) =>
        current.map((unit) => {
          const replacement = hydrated.get(unit.id);
          return replacement
            ? {
                ...replacement,
                status: unit.status,
                changedSinceSignOff: unit.changedSinceSignOff,
                waitingSince: unit.waitingSince,
              }
            : unit;
        }),
      );
    };
    setSourceLoading(true);
    void hydratePrivateReviewSources(
      initialData.units,
      initialData.snapshot.id,
      cache,
      6,
      controller.signal,
      (_index, hydrated) => {
        if (!live) return;
        hydratedById.set(hydrated.id, hydrated);
        flushTimer ??= setTimeout(flushHydrated, 0);
      },
    )
      .then(({ failures }) => {
        if (!live) return;
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushHydrated();
        if (failures.length > 0) {
          toast.error(
            `${failures.length} source file${failures.length === 1 ? "" : "s"} could not be loaded`,
          );
        }
      })
      .catch((cause: unknown) => {
        if (!live || controller.signal.aborted) return;
        toast.error("Repository source files could not be loaded", {
          description:
            cause instanceof Error ? cause.message : "Please try again.",
        });
      })
      .finally(() => {
        if (live) setSourceLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      cache.clear();
    };
  }, [initialData]);

  const paths = useMemo(() => {
    const query = search.trim().toLowerCase();
    const grouped = new Map<string, typeof units>();
    for (const unit of units) {
      if (
        query &&
        !unit.path.toLowerCase().includes(query) &&
        !unit.name.toLowerCase().includes(query)
      ) {
        continue;
      }
      grouped.set(unit.path, [...(grouped.get(unit.path) ?? []), unit]);
    }
    return [...grouped.entries()];
  }, [search, units]);
  const signed = units.filter(({ status }) => status === "signed_off").length;
  const percent = units.length ? Math.round((signed / units.length) * 100) : 0;
  const pending = units.filter(({ status }) => status !== "signed_off");

  const signOff = api.review.signOff.useMutation({
    onMutate: ({ unitId }) => {
      const previousStatus = units.find(({ id }) => id === unitId)?.status;
      setUnits((current) =>
        current.map((unit) =>
          unit.id === unitId
            ? { ...unit, status: "signed_off" as const }
            : unit,
        ),
      );
      return { previousStatus };
    },
    onSuccess: (_result, { unitId }) => {
      const next = units.find(
        (unit) => unit.id !== unitId && unit.status !== "signed_off",
      );
      if (next) setActiveId(next.id);
      toast.success("Marked as read");
    },
    onError: (error, { unitId }, context) => {
      const previousStatus = context?.previousStatus;
      if (previousStatus) {
        setUnits((current) =>
          current.map((unit) =>
            unit.id === unitId ? { ...unit, status: previousStatus } : unit,
          ),
        );
      }
      toast.error("Could not save reading progress", {
        description: error.message,
      });
    },
  });
  const unreview = api.review.unreview.useMutation({
    onMutate: ({ unitId }) => {
      const previousStatus = units.find(({ id }) => id === unitId)?.status;
      setUnits((current) =>
        current.map((unit) =>
          unit.id === unitId ? { ...unit, status: "pending" as const } : unit,
        ),
      );
      return { previousStatus };
    },
    onError: (error, { unitId }, context) => {
      const previousStatus = context?.previousStatus;
      if (previousStatus) {
        setUnits((current) =>
          current.map((unit) =>
            unit.id === unitId ? { ...unit, status: previousStatus } : unit,
          ),
        );
      }
      toast.error("Could not restore unit", { description: error.message });
    },
  });
  const showPrevious = previousUnitId === activeId;
  const displayedSource =
    showPrevious && active?.previousSource !== null
      ? active?.previousSource
      : active?.source;
  const displayedStartLine = showPrevious
    ? previousStartLine(active)
    : (active?.startLine ?? 1);

  return (
    <main className="flex h-[calc(100vh-4.5rem)] min-h-[620px] flex-col overflow-hidden bg-ink lg:h-screen">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 sm:px-5">
        <Button size="icon" variant="ghost" asChild>
          <Link href="/repo-reviews" aria-label="Back to repo reviews">
            <ArrowLeft className="size-4" />
            <LinkPendingSpinner />
          </Link>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={sidebarOpen ? "Hide review path" : "Show review path"}
          onClick={() => setSidebarOpen((value) => !value)}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="size-4" />
          ) : (
            <PanelLeftOpen className="size-4" />
          )}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-cloud">
            {monitor.repositoryOwner}/{monitor.repositoryName}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-mist">
            <GitBranch className="size-3" /> {monitor.branch}
            <span>·</span>
            <span className="font-mono">
              {monitor.snapshot?.headSha.slice(0, 7)}
            </span>
          </div>
        </div>
        <div className="hidden w-44 sm:block">
          <div className="flex items-center justify-between text-[11px] text-mist">
            <span>
              {signed}/{units.length} read
            </span>
            <span>{percent}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-subtle">
            <div
              className="h-full rounded-full bg-lime transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="w-[320px] shrink-0 overflow-y-auto border-r border-line bg-panel max-md:absolute max-md:inset-y-16 max-md:left-0 max-md:z-20 max-md:shadow-2xl">
            <div className="sticky top-0 z-10 border-b border-line bg-panel p-3">
              <label className="relative block">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find file or symbol"
                  className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-xs text-cloud outline-none focus:border-lime/50"
                />
              </label>
              {pending.some(
                ({ changedSinceSignOff }) => changedSinceSignOff,
              ) && (
                <div className="mt-3 rounded-xl border border-lime/20 bg-lime/7 px-3 py-2 text-[11px] text-lime">
                  Changed since your last read is pinned into the path below.
                </div>
              )}
            </div>
            <div className="p-2">
              {paths.length === 0 && (
                <div
                  className="mx-2 mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center"
                  aria-live="polite"
                >
                  <Search className="mx-auto size-5 text-fog" />
                  <p className="mt-3 text-xs font-medium text-cloud">
                    {search.trim()
                      ? `No files or symbols match “${search.trim()}”.`
                      : "No reviewable symbols are available in this snapshot."}
                  </p>
                  {search.trim() && (
                    <button
                      type="button"
                      className="mt-3 text-xs font-medium text-lime hover:text-lime-bright"
                      onClick={() => setSearch("")}
                    >
                      Clear search
                    </button>
                  )}
                </div>
              )}
              {paths.map(([path, pathUnits]) => (
                <div key={path} className="mb-2">
                  <div className="flex items-center gap-2 px-2 py-2 text-[11px] font-medium text-mist">
                    <FileCode2 className="size-3.5 shrink-0" />
                    <span className="truncate">{path}</span>
                  </div>
                  {pathUnits.map((unit) => (
                    <button
                      key={unit.id}
                      type="button"
                      aria-current={active?.id === unit.id ? "true" : undefined}
                      onClick={() => {
                        setActiveId(unit.id);
                        if (window.innerWidth < 768) setSidebarOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition",
                        active?.id === unit.id
                          ? "bg-lime/9 text-cloud"
                          : "text-mist hover:bg-surface-hover hover:text-cloud",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1 size-2 shrink-0 rounded-full",
                          unit.status === "signed_off"
                            ? "bg-lime"
                            : unit.changedSinceSignOff
                              ? "bg-amber-400"
                              : "border border-line-strong",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">
                          {unit.name}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-fog">
                          {unit.kind} · lines {unit.startLine}-{unit.endLine}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </aside>
        )}

        <section className="flex min-w-0 flex-1 flex-col bg-code">
          {active ? (
            <>
              <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-cloud">
                    {active.path}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-mist">
                    {active.kind} · {active.name}
                  </div>
                </div>
                {active.changedSinceSignOff && (
                  <span className="rounded-lg border border-amber-400/25 bg-amber-400/8 px-2 py-1 text-[10px] font-semibold text-amber-300">
                    Changed since read
                  </span>
                )}
                {active.previousSource !== null && (
                  <div className="flex rounded-lg border border-line bg-surface-subtle p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setPreviousUnitId(undefined)}
                      className={cn(
                        "rounded-md px-2.5 py-1",
                        !showPrevious
                          ? "bg-surface text-cloud shadow-sm"
                          : "text-mist",
                      )}
                    >
                      Current
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviousUnitId(active.id)}
                      className={cn(
                        "rounded-md px-2.5 py-1",
                        showPrevious
                          ? "bg-surface text-cloud shadow-sm"
                          : "text-mist",
                      )}
                    >
                      Previous
                    </button>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {sourceLoading && !displayedSource ? (
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-mist">
                    <LoaderCircle className="size-4 animate-spin" /> Loading
                    verified source…
                  </div>
                ) : (
                  <pre className="min-w-max py-5 font-mono text-[12px] leading-6 text-cloud">
                    {sourceLines(displayedSource ?? "", displayedStartLine).map(
                      (line) => (
                        <div
                          key={line.number}
                          className="group flex min-h-6 hover:bg-surface-hover/45"
                        >
                          <span className="sticky left-0 w-16 shrink-0 select-none border-r border-line/60 bg-code pr-3 text-right text-fog group-hover:bg-surface-hover">
                            {line.number}
                          </span>
                          <code className="whitespace-pre px-4">
                            {line.content || " "}
                          </code>
                        </div>
                      ),
                    )}
                  </pre>
                )}
              </div>
              <footer className="flex h-16 shrink-0 items-center justify-between gap-3 border-t border-line bg-panel px-4">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={activeIndex <= 0}
                  onClick={() => setActiveId(units[activeIndex - 1]?.id)}
                >
                  <ChevronLeft className="size-4" /> Previous
                </Button>
                {active.status === "signed_off" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={unreview.isPending}
                    onClick={() => unreview.mutate({ unitId: active.id })}
                  >
                    <Undo2 className="size-4" /> Mark unread
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    loading={signOff.isPending}
                    onClick={() =>
                      signOff.mutate({ unitId: active.id, durationSeconds: 0 })
                    }
                  >
                    <Check className="size-4" /> Mark read &amp; continue
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={activeIndex >= units.length - 1}
                  onClick={() => setActiveId(units[activeIndex + 1]?.id)}
                >
                  Next <ChevronRight className="size-4" />
                </Button>
              </footer>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <CheckCircle2 className="mx-auto size-9 text-lime" />
                <h2 className="mt-4 font-semibold text-cloud">
                  No reviewable source units
                </h2>
                <p className="mt-2 text-sm text-mist">
                  The snapshot contains no supported code symbols.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
