import { TriangleAlert } from "lucide-react";
import { Badge } from "~/components/ui/badge";

/** Identifies confirmed merge conflicts without implying the review is blocked. */
export function MergeConflictBadge() {
  return (
    <Badge
      className="gap-1.5 border-red-700/25 bg-red-700/[.07] text-red-800 dark:border-red-300/25 dark:bg-red-300/10 dark:text-red-200"
      title="Merging is blocked by conflicts with the target branch. You can still review this pull request."
      aria-label="Merge blocked: conflicts with the target branch"
    >
      <TriangleAlert aria-hidden="true" className="size-3" />
      Blocked <span aria-hidden="true">·</span> Conflicts
    </Badge>
  );
}
