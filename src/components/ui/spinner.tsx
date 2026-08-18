import { LoaderCircle } from "lucide-react";
import { cn } from "~/lib/utils";

/** Renders the shared busy indicator used by buttons and pending navigations. */
export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden
      className={cn("size-4 shrink-0 animate-spin", className)}
    />
  );
}
