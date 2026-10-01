"use client";

import dynamic from "next/dynamic";

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
