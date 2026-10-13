/** Leaves room for base64 and tRPC metadata under hosted request limits. */
export const COMMENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const COMMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** Recognizes Markdown and HTML image attachments, excluding priority badges. */
export function providerCommentHasImages(body: string) {
  const content = body.replace(/(`{3,}|~{3,})[\s\S]*?\1/gu, "");
  const markdown = [
    ...content.matchAll(
      /!\[([^\]]*)\]\(\s*<?(?:https?:\/\/|\/|\.{1,2}\/)[^\s)]+/giu,
    ),
  ];
  if (markdown.some((match) => !/^P[0-4]$/iu.test(match[1]?.trim() ?? ""))) {
    return true;
  }
  const references = new Set(
    [
      ...content.matchAll(
        /^\s{0,3}\[([^\]]+)\]:\s*<?(?:https?:\/\/|\/|\.{1,2}\/)[^\s>]+/gimu,
      ),
    ].map((match) => match[1]?.trim().toLocaleLowerCase()),
  );
  if (
    [...content.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?/gu)].some(
      (match) =>
        !/^P[0-4]$/iu.test(match[1]?.trim() ?? "") &&
        references.has((match[2] || match[1])?.trim().toLocaleLowerCase()),
    )
  )
    return true;
  return [...content.matchAll(/<img\b[^>]*>/giu)].some(([tag]) => {
    const alt = /\balt\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1] ?? "";
    return (
      /\bsrc\s*=\s*["'](?:https?:\/\/|\/|\.{1,2}\/)/iu.test(tag) &&
      !/^P[0-4]$/iu.test(alt.trim())
    );
  });
}
