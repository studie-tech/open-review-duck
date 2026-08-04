type MaintenanceTask = () => Promise<unknown>;

/** Runs independent maintenance tasks without discarding successful results. */
export async function settleMaintenanceTasks(
  tasks: Record<string, MaintenanceTask>,
) {
  const entries = Object.entries(tasks);
  const settled = await Promise.allSettled(
    entries.map(([, task]) => Promise.resolve().then(task)),
  );
  let failed = false;
  const results = Object.fromEntries(
    settled.map((result, index) => {
      const name = entries[index]?.[0] ?? `task-${index}`;
      if (result.status === "fulfilled") return [name, result.value];
      failed = true;
      return [
        name,
        {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : "Maintenance task failed",
        },
      ];
    }),
  );
  return { failed, results };
}
