import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

/** Renders the badge interface. */
export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "text-mist inline-flex items-center rounded-lg border border-line bg-surface-subtle px-2.5 py-1 text-[11px] font-medium",
        className,
      )}
      {...props}
    />
  );
}
