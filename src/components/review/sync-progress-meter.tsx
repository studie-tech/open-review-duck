import { syncProgressLabel } from "~/lib/sync-progress";

/** Renders one durable pull-request synchronization progress bar. */
export function SyncProgressMeter({
  label,
  progress,
  status,
}: {
  label: string;
  progress: number;
  status: string;
}) {
  const clamped = Math.min(99, Math.max(0, progress));
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-3">
        <div
          className="bg-surface-subtle h-1.5 min-w-16 flex-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clamped}
        >
          <div
            className="bg-cyan h-full rounded-full transition-[width] duration-500"
            style={{ width: `${clamped}%` }}
          />
        </div>
        <span className="text-cyan shrink-0 text-[11px] tabular-nums">
          {clamped}%
        </span>
      </div>
      <p className="text-fog mt-1.5 truncate text-[11px]">
        {syncProgressLabel(status, clamped)}
      </p>
    </div>
  );
}
