"use client";

import { RecoveryError } from "~/components/recovery-error";

/** Presents a recoverable review-loading failure without misreporting a 404. */
export default function ReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RecoveryError
      backHref="/pullrequests"
      backLabel="Back to reviews"
      description="The data connection may still be waking up or temporarily unavailable. Your existing review progress is safe."
      error={error}
      eyebrow="Review temporarily unavailable"
      logLabel="Review workspace failed to load"
      reset={reset}
      title="We couldn’t load this review."
    />
  );
}
