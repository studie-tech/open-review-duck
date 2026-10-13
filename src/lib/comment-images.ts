/** Leaves room for base64 and tRPC metadata under hosted request limits. */
export const COMMENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const COMMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

const GITHUB_IMAGE_HOSTS = new Set([
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
]);

/** Auto-loads HTTPS provider attachments, leaving other origins behind an explicit click. */
export function canAutomaticallyPreviewCommentImage(
  src: string,
  baseUrl?: string,
) {
  try {
    const url = new URL(src);
    const provider = baseUrl ? new URL(baseUrl) : undefined;
    return (
      !url.username &&
      !url.password &&
      url.protocol === "https:" &&
      (url.origin === provider?.origin || GITHUB_IMAGE_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

/** Recognizes Markdown and HTML image attachments, excluding priority badges. */
export function providerCommentHasImages(body: string) {
  const content = body
    .replace(/(`{3,}|~{3,})[\s\S]*?\1/gu, "")
    .replace(/(`+)[\s\S]*?\1/gu, "");
  const markdown = [...content.matchAll(/!\[([^\]]*)\]\(\s*<?([^\s)>]+)/giu)];
  if (
    markdown.some(
      (match) =>
        !/^P[0-4]$/iu.test(match[1]?.trim() ?? "") &&
        isCommentImageSource(match[2] ?? ""),
    )
  ) {
    return true;
  }
  const references = new Set(
    [...content.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)/gimu)]
      .filter((match) => isCommentImageSource(match[2] ?? ""))
      .map((match) => match[1]?.trim().toLocaleLowerCase()),
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
      isCommentImageSource(
        /\bsrc\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1] ?? "",
      ) && !/^P[0-4]$/iu.test(alt.trim())
    );
  });
}

/** Includes safe relative image paths without recognizing executable URL schemes. */
function isCommentImageSource(src: string) {
  if (!src.trim()) return false;
  try {
    const url = new URL(src, "https://attachment.invalid/");
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
