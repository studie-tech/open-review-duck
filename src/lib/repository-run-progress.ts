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

/** Folds live run rows into cached monitors so the heavy list stays put. */
export function mergeRepositoryRunProgress<
  Live extends { monitorId: string },
  Monitor extends { id: string } & Omit<Live, "monitorId">,
>(monitors: readonly Monitor[], live: readonly Live[]): Monitor[] {
  const byMonitor = new Map(
    live.map(({ monitorId, ...fields }) => [monitorId, fields]),
  );
  return monitors.map((monitor) => {
    const fields = byMonitor.get(monitor.id);
    return fields ? { ...monitor, ...fields } : monitor;
  });
}
