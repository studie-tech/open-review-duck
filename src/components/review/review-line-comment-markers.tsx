"use client";

import { cn } from "~/lib/utils";

export interface ReviewLineCommentMarker {
  author: string;
  authorAvatarUrl?: string;
  resolved: boolean;
  threadExternalId: string;
}

/** Turns provider threads into gutter markers, one per conversation. */
export function reviewLineCommentMarkersBySide(
  threads: readonly {
    comments: readonly {
      author: string;
      authorAvatarUrl?: string;
    }[];
    externalId: string;
    line: number;
    side: "left" | "right";
    status: string;
  }[],
) {
  const left = new Map<number, ReviewLineCommentMarker[]>();
  const right = new Map<number, ReviewLineCommentMarker[]>();
  for (const thread of threads) {
    const first = thread.comments[0];
    if (!first) continue;
    const marker: ReviewLineCommentMarker = {
      author: first.author,
      authorAvatarUrl: first.authorAvatarUrl,
      resolved: thread.status === "resolved",
      threadExternalId: thread.externalId,
    };
    const bucket = thread.side === "left" ? left : right;
    const group = bucket.get(thread.line) ?? [];
    group.push(marker);
    bucket.set(thread.line, group);
  }
  return { left, right };
}

/** Reads the markers for one rendered line, optionally limited to one side. */
export function reviewLineCommentMarkersForLine(
  markers: {
    left: ReadonlyMap<number, readonly ReviewLineCommentMarker[]>;
    right: ReadonlyMap<number, readonly ReviewLineCommentMarker[]>;
  },
  line: number,
  side?: "left" | "right",
) {
  if (side === "left") return markers.left.get(line) ?? [];
  if (side === "right") return markers.right.get(line) ?? [];
  return [
    ...(markers.left.get(line) ?? []),
    ...(markers.right.get(line) ?? []),
  ];
}

const VISIBLE_MARKERS = 2;

/** Names the poster and whether their conversation is still open. */
function markerLabel(marker: ReviewLineCommentMarker) {
  return marker.resolved
    ? `Open resolved comment by ${marker.author}`
    : `Open comment by ${marker.author}`;
}

/** GitHub-style stacked avatars for conversations anchored on a source line. */
export function ReviewLineCommentMarkers({
  markers,
  onOpen,
  className,
}: {
  markers: readonly ReviewLineCommentMarker[];
  onOpen: (threadExternalId: string) => void;
  className?: string;
}) {
  if (markers.length === 0) return null;
  const [firstMarker] = markers;
  const visible = markers.slice(0, VISIBLE_MARKERS);
  const extra = markers.length - visible.length;
  return (
    <fieldset
      className={cn("m-0 flex items-center border-0 p-0", className)}
      aria-label={
        markers.length === 1 && firstMarker
          ? markerLabel(firstMarker)
          : `${markers.length} comments on this line`
      }
    >
      {visible.map((marker, index) => (
        <button
          key={marker.threadExternalId}
          type="button"
          aria-label={markerLabel(marker)}
          title={markerLabel(marker)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(marker.threadExternalId);
          }}
          className={cn(
            "relative size-4 shrink-0 overflow-hidden rounded-full bg-surface-hover text-[8px] font-medium text-cloud ring-1 ring-panel transition hover:z-10 hover:ring-cyan/50",
            index > 0 && "-ml-1",
            marker.resolved && "opacity-70",
          )}
        >
          {marker.authorAvatarUrl ? (
            // biome-ignore lint/performance/noImgElement: provider avatars are remote URLs, not app-optimized assets
            <img
              src={marker.authorAvatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="size-full object-cover"
            />
          ) : (
            <span className="grid size-full place-items-center">
              {marker.author.slice(0, 1).toUpperCase()}
            </span>
          )}
          {marker.resolved && (
            <span
              aria-hidden="true"
              className="bg-lime ring-panel absolute right-0 bottom-0 size-1.5 rounded-full ring-1"
            />
          )}
        </button>
      ))}
      {extra > 0 && (
        <span className="text-fog ml-0.5 font-sans text-[8px] tabular-nums">
          +{extra}
        </span>
      )}
    </fieldset>
  );
}
