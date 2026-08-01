"use client";

/** Provides an entirely local recovery UI for otherwise-unhandled React failures. */
export default function LocalGlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
