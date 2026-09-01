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
