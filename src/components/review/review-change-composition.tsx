"use client";

import { useMemo } from "react";
import {
  type ReviewChangeComposition as Composition,
  type ReviewFileEntry,
  reviewChangeComposition,
} from "~/lib/review-files";
import { cn } from "~/lib/utils";

const segments: {
  key: keyof Composition;
  label: string;
  bar: string;
  dot: string;
}[] = [
  {
    key: "movedUnchanged",
    label: "moved unchanged",
    bar: "bg-fog/45",
    dot: "bg-fog/60",
  },
  {
    key: "movedEdited",
    label: "moved + edited",
    bar: "bg-amber-400/80",
    dot: "bg-amber-400",
  },
  { key: "modified", label: "modified", bar: "bg-cyan/80", dot: "bg-cyan" },
  { key: "added", label: "added", bar: "bg-addition/80", dot: "bg-addition" },
  { key: "deleted", label: "deleted", bar: "bg-coral/80", dot: "bg-coral" },
];

/**
 * Shows the shape of a revision before any file is opened: how many of its
 * files only moved, moved and changed, changed in place, arrived or left.
 *
 * A revision that relocates a subtree looks enormous by file count. The bar
 * makes the relocation visible as one quiet segment so the reviewer sees at a
 * glance how much of the change is actually work.
 */
export function ReviewChangeComposition({
  files,
  className,
}: {
  files: readonly ReviewFileEntry[];
  className?: string;
}) {
  const composition = useMemo(() => reviewChangeComposition(files), [files]);
  const total = files.length;
  const present = segments.filter(({ key }) => composition[key] > 0);
  if (total === 0 || present.length === 0) return null;
  const description = present
    .map(({ key, label }) => `${composition[key]} ${label}`)
    .join(", ");
  return (
    <div className={cn("min-w-0", className)}>
      <div
        role="img"
        aria-label={`Changed files by kind: ${description}`}
        title={description}
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-hover"
      >
        {present.map(({ key, bar }) => (
          <span
            key={key}
            aria-hidden="true"
            className={cn("h-full min-w-0.5", bar)}
            style={{ flexGrow: composition[key] }}
          />
        ))}
      </div>
      <ul
        aria-hidden="true"
        className="text-fog mt-1.5 m-0 flex list-none flex-wrap gap-x-2.5 gap-y-0.5 p-0 text-[9px] leading-3"
      >
        {present.map(({ key, label, dot }) => (
          <li key={key} className="flex items-center gap-1 whitespace-nowrap">
            <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
            <span className="text-mist tabular-nums">{composition[key]}</span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
