"use client";

import dynamic from "next/dynamic";
import { isReviewNotebookFile } from "~/lib/review-source-display";

/**
 * Loads Markdown only when a reviewer opens generated or provider-authored text.
 *
 * The renderer pulls in the remark/rehype parsing stack, while every caller is
 * behind an interaction or completed async job and does not need it at first
 * paint.
 */
export const ProviderCommentBody = dynamic(() =>
  import("./provider-comment-body").then(
    (module) => module.ProviderCommentBody,
  ),
);

/**
 * Loads the Markdown document preview only when a reviewer opens an .md file.
 *
 * The switch itself stays eager; this payload is the remark/rehype document
 * renderer that Focus/Diff never need.
 */
export const ReviewMarkdownPreview = dynamic(
  () =>
    import("./review-markdown-preview").then(
      (module) => module.ReviewMarkdownPreview,
    ),
  {
    loading: () => (
      <div className="text-fog px-6 py-10 text-center text-xs" role="status">
        Rendering Markdown…
      </div>
    ),
  },
);

const ReviewNotebookPreview = dynamic(
  () =>
    import("./review-notebook-preview").then(
      (module) => module.ReviewNotebookPreview,
    ),
  {
    loading: () => (
      <div className="px-6 py-10 text-center text-xs text-fog" role="status">
        Rendering notebook…
      </div>
    ),
  },
);

/** Loads the appropriate document renderer without loading notebooks for code. */
export function ReviewDocumentPreview(props: {
  currentSource: string;
  previousSource?: string;
  path: string;
}) {
  return isReviewNotebookFile(props) ? (
    <ReviewNotebookPreview {...props} />
  ) : (
    <ReviewMarkdownPreview {...props} />
  );
}
