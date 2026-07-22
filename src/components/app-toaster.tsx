"use client";

import { Toaster } from "sonner";

/** Renders the app toaster interface. */
export function AppToaster() {
  return (
    <Toaster
      richColors
      position="bottom-right"
      toastOptions={{
        style: {
          background: "var(--app-surface)",
          border: "1px solid var(--app-border)",
          color: "var(--app-text)",
        },
      }}
    />
  );
}
