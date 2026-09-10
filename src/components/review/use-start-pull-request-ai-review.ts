"use client";

import { toast } from "sonner";
import { api } from "~/trpc/react";
import { showAiStartError } from "./review-workspace-diff";

/** Starts an evidence-based pull request review and reports the outcome. */
export function useStartPullRequestAiReview(options?: {
  onSuccess?: () => void;
}) {
  return api.ai.start.useMutation({
    onSuccess: () => {
      toast.success("Pull request review started", {
        description:
          "Findings will appear inline as the review agent completes its analysis.",
      });
      options?.onSuccess?.();
    },
    onError: showAiStartError,
  });
}
