import { cn } from "~/lib/utils";

/** Renders a pulsing placeholder block for loading states. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("bg-surface-hover animate-pulse rounded-xl", className)}
    />
  );
}
