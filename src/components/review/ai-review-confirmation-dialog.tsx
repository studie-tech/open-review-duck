"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";

/** Confirms an evidence-based AI review of one pull request. */
export function AiReviewConfirmationDialog({
  pending = false,
  onCancel,
  onConfirm,
}: {
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmationDialog
      title="Review this pull request with AI?"
      description={
        <>
          The review agent will inspect all changed files and add
          evidence-backed findings beside the relevant code. This uses your
          configured model and contributes to this PR&apos;s token usage.
        </>
      }
      confirmLabel="Start AI review"
      pendingLabel={
        <>
          <LoaderCircle className="size-4 animate-spin" />
          Starting…
        </>
      }
      pending={pending}
      icon={<Sparkles className="text-violet size-4" />}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
