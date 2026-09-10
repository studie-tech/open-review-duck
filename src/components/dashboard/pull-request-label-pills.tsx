import type { CSSProperties } from "react";
import {
  type PullRequestLabel,
  pullRequestLabelStyle,
} from "~/lib/pull-request-labels";
import { cn } from "~/lib/utils";

const MAX_VISIBLE_LABELS = 6;
const pillClassName =
  "inline-flex max-w-full items-center rounded-[2em] border px-[7px] text-xs leading-[18px] font-medium";

/** Renders provider pull-request labels as GitHub-style colored pills. */
export function PullRequestLabelPills({
  className,
  labels,
}: {
  className?: string;
  labels?: readonly PullRequestLabel[] | null;
}) {
  if (!labels?.length) return null;
  const visible = labels.slice(0, MAX_VISIBLE_LABELS);
  const overflow = labels.length - visible.length;

  return (
    <span className={cn("mt-1.5 flex flex-wrap gap-1", className)}>
      {visible.map((label) => (
        <span
          key={label.name}
          title={label.description ?? label.name}
          className={cn("pull-request-label", pillClassName)}
          style={pullRequestLabelStyle(label) as CSSProperties}
        >
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {overflow > 0 && (
        <span
          className={cn(
            pillClassName,
            "text-fog border-line bg-surface-subtle",
          )}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
