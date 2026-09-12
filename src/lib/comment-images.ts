/** Leaves room for base64 and tRPC metadata under hosted request limits. */
export const COMMENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const COMMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
