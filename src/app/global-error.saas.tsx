"use client";

import "~/styles/globals.css";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { RecoveryError } from "~/components/recovery-error";

/** Reports otherwise-unhandled React failures and provides a branded recovery UI. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="bg-ink text-cloud antialiased">
        <RecoveryError
          backHref="/"
          backLabel="Back to home"
          description="An unexpected error prevented your workspace from loading. Try again or return home."
          error={error}
          eyebrow="ReviewDuck temporarily unavailable"
          logLabel="Application failed to load"
          reset={reset}
          title="We couldn’t load your workspace."
        />
      </body>
    </html>
  );
}
