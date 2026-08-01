"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/** Reports otherwise-unhandled React failures and provides a minimal recovery UI. */
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
      <body>
        <main>
          <h1>ReviewDuck could not load.</h1>
          <p>Your saved work is safe. Retry the request to continue.</p>
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
