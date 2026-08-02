"use client";

import { RecoveryError } from "~/components/recovery-error";

/** Handles recoverable failures from authenticated application layouts and pages. */
export default function ApplicationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RecoveryError
      backHref="/"
      backLabel="Back to home"
      description="The data connection may still be waking up or temporarily unavailable. Your saved reviews and settings are safe."
      error={error}
      eyebrow="ReviewDuck temporarily unavailable"
      logLabel="Application failed to load"
      reset={reset}
      title="We couldn’t load your workspace."
    />
  );
}
