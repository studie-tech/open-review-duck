/** Durable statuses that keep a repository run visibly in flight. */
export const activeRunStatuses = new Set([
  "queued",
  "waiting_for_provider",
  "running",
  "streaming",
]);

type RunState = {
  latestCodeRun: { status: string } | null;
  latestComplianceRun: { status: string } | null;
};

/** Reports whether any monitor still has an AI repository run in flight. */
export function hasActiveRepositoryRun(monitors: readonly RunState[]) {
  return monitors.some(
    ({ latestCodeRun, latestComplianceRun }) =>
      activeRunStatuses.has(latestCodeRun?.status ?? "") ||
      activeRunStatuses.has(latestComplianceRun?.status ?? ""),
  );
}

/**
 * Folds live run rows into cached monitors so the heavy list stays put.
 *
 * A progress read resolved against a snapshot the list has since replaced
 * carries run state that belongs to the old snapshot, so its runs are dropped
 * and only the sync — which is keyed on the monitor — is taken.
 */
export function mergeRepositoryRunProgress<
  Live extends {
    monitorId: string;
    snapshotId: string | null;
    activeSync: unknown;
  },
  Monitor extends { id: string; snapshot: { id: string } | null } & Omit<
    Live,
    "monitorId" | "snapshotId"
  >,
>(monitors: readonly Monitor[], live: readonly Live[]): Monitor[] {
  const byMonitor = new Map(
    live.map(({ monitorId, ...fields }) => [monitorId, fields]),
  );
  return monitors.map((monitor) => {
    const fields = byMonitor.get(monitor.id);
    if (!fields) return monitor;
    const { snapshotId, activeSync, ...runs } = fields;
    return snapshotId === (monitor.snapshot?.id ?? null)
      ? { ...monitor, activeSync, ...runs }
      : { ...monitor, activeSync };
  });
}
