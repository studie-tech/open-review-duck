import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** Renders the page container interface. */
export function PageContainer({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14",
        className,
      )}
      {...props}
    />
  );
}
