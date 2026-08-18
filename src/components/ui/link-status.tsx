"use client";

import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

/**
 * Swaps `idle` content for `pending` content while the enclosing Link
 * navigates. Must be rendered inside a `next/link` Link.
 */
export function LinkNavigationStatus({
  idle,
  pending,
}: {
  idle: ReactNode;
  pending: ReactNode;
}) {
  const status = useLinkStatus();
  return <>{status.pending ? pending : idle}</>;
}

/**
 * Shows a spinner while the enclosing Link navigates. The reveal is delayed so
 * prefetched, near-instant navigations never flash it.
 */
export function LinkPendingSpinner({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Spinner className={cn("navigation-pending-reveal", className)} />;
}
