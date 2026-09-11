"use client";

import { toast } from "sonner";
import { api } from "~/trpc/react";
import { showAiStartError } from "./review-workspace-diff";

/** Starts an evidence-based pull request review and reports the outcome. */
export function useStartPullRequestAiReview(options?: {
  onSuccess?: () => void;
}) {
  const utils = api.useUtils();
  return api.ai.start.useMutation({
    onSuccess: (job) => {
      utils.ai.reviewStatus.setData({ pullRequestId: job.pullRequestId }, job);
      void utils.ai.reviewRuns.invalidate();
      void utils.ai.reviewHistory.invalidate();
      void utils.review.deepReviewFindings.invalidate();
      toast.success("Pull request review started", {
        description:
          "Findings will appear inline as the review agent completes its analysis.",
      });
      options?.onSuccess?.();
    },
    onError: showAiStartError,
  });
}
