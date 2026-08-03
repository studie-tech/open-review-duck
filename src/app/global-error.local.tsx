"use client";

import "~/styles/globals.css";

import { RecoveryError } from "~/components/recovery-error";

/** Provides an entirely local recovery UI for otherwise-unhandled React failures. */
export default function LocalGlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-ink text-cloud antialiased">
        <RecoveryError
          backHref="/"
          backLabel="Back to home"
          description="The local data service may still be starting or temporarily unavailable. Your saved reviews and settings are safe."
          error={error}
          eyebrow="ReviewDuck temporarily unavailable"
          logLabel="Local application failed to load"
          reset={reset}
          title="We couldn’t load your workspace."
        />
      </body>
    </html>
  );
}
