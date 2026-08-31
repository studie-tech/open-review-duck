"use client";

import { FileImage } from "lucide-react";
import { useState } from "react";
import {
  isPreviewableReviewImage,
  reviewImagePreviewUrl,
} from "~/lib/review-images";

/** Placeholder shown when a binary change cannot be rendered. */
export function ReviewBinaryPlaceholder({ path }: { path: string }) {
  return (
    <div className="mx-auto grid min-h-72 max-w-lg place-items-center px-6 py-12 font-sans">
      <div className="w-full rounded-2xl border border-line bg-surface/45 p-8 text-center shadow-[0_18px_60px_var(--app-shadow)]">
        <span className="bg-cyan/10 text-cyan mx-auto grid size-11 place-items-center rounded-xl">
          <FileImage className="size-5" aria-hidden="true" />
        </span>
        <p className="text-cloud mt-4 text-sm font-medium">Binary file</p>
        <p className="text-mist mt-2 text-xs leading-5">
          ReviewDuck detected binary content. Its bytes are not displayed, sent
          to AI, or available for line comments.
        </p>
        <p className="text-fog mt-3 truncate font-mono text-[10px]">{path}</p>
      </div>
    </div>
  );
}

/** Renders a previewable image in a review card, or the binary placeholder. */
export function ReviewBinaryPreview({
  path,
  unitId,
}: {
  path: string;
  unitId: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!isPreviewableReviewImage(path) || failed) {
    return <ReviewBinaryPlaceholder path={path} />;
  }
  const name = path.split("/").at(-1) ?? path;
  return (
    <div className="mx-auto grid min-h-72 max-w-3xl place-items-center px-6 py-8 font-sans">
      <figure className="w-full overflow-hidden rounded-2xl border border-line bg-surface/45 p-4 shadow-[0_18px_60px_var(--app-shadow)]">
        {/* biome-ignore lint/performance/noImgElement: authorized preview bytes are served from our own cookie-gated route */}
        <img
          src={reviewImagePreviewUrl(unitId)}
          alt={name}
          onError={() => setFailed(true)}
          className="mx-auto max-h-[min(32rem,70vh)] max-w-full object-contain"
        />
        <figcaption className="text-fog mt-3 truncate text-center font-mono text-[10px]">
          {path}
        </figcaption>
      </figure>
    </div>
  );
}
