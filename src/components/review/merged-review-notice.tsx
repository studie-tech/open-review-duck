import { ChevronRight, GitMerge } from "lucide-react";
import { Button } from "~/components/ui/button";

/** Uses terminal merge evidence even while a newer source revision is staged. */
export function reviewIsMerged(
  workspaceState: string,
  lifecycleState?: string,
) {
  return workspaceState === "merged" || lifecycleState === "merged";
}

/** Replaces the active review call to action with an exit from a merged PR. */
export function MergedReviewFooter({
  signedCount,
  totalCount,
  navigationPending,
  onBack,
}: {
  signedCount: number;
  totalCount: number;
  navigationPending: boolean;
  onBack: () => void;
}) {
  return (
    <div className="border-violet/25 bg-violet/[.06] flex flex-wrap items-center justify-between gap-3 border-t px-3 py-3 sm:px-7 sm:py-4">
      <div className="min-w-0">
        <p className="text-violet flex items-center gap-2 text-xs font-medium">
          <GitMerge aria-hidden="true" className="size-4" />
          Merged pull request
        </p>
        <p className="text-mist mt-1 text-[10px]">
          Personal review: {signedCount}/{totalCount} units signed off
        </p>
      </div>
      <Button variant="secondary" loading={navigationPending} onClick={onBack}>
        Back to pull requests
        {!navigationPending && <ChevronRight className="size-4" />}
      </Button>
    </div>
  );
}

/** Keeps merge status separate from the reviewer's personal sign-off ledger. */
export function MergedReviewNotice({ targetBranch }: { targetBranch: string }) {
  return (
    <section
      role="status"
      aria-label="Merged pull request"
      className="border-violet/25 bg-violet/10 flex shrink-0 items-start gap-3 border-b px-4 py-3 sm:items-center sm:px-6"
    >
      <span className="bg-violet/15 text-violet grid size-9 shrink-0 place-items-center rounded-xl">
        <GitMerge aria-hidden="true" className="size-5" />
      </span>
      <div className="min-w-0">
        <h2 className="text-cloud text-sm font-medium">
          This pull request has been merged
        </h2>
        <p className="text-mist mt-0.5 text-xs leading-5">
          Changes were merged into{" "}
          <code className="text-cloud break-all">{targetBranch}</code>. You’re
          viewing the saved review snapshot. Personal review progress is kept
          separately.
        </p>
      </div>
    </section>
  );
}
