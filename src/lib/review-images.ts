const PREVIEWABLE_IMAGE_EXTENSIONS = new Map([
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

const IMAGE_SIGNATURES: Array<{
  mediaType: string;
  matches: (bytes: Uint8Array) => boolean;
}> = [
  {
    mediaType: "image/png",
    matches: (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47,
  },
  {
    mediaType: "image/jpeg",
    matches: (bytes) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
  },
  {
    mediaType: "image/gif",
    matches: (bytes) =>
      bytes.length >= 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38,
  },
  {
    mediaType: "image/webp",
    matches: (bytes) =>
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50,
  },
  {
    mediaType: "image/bmp",
    matches: (bytes) =>
      bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d,
  },
  {
    mediaType: "image/x-icon",
    matches: (bytes) =>
      bytes.length >= 4 &&
      bytes[0] === 0 &&
      bytes[1] === 0 &&
      bytes[2] === 1 &&
      bytes[3] === 0,
  },
];

/** The most bytes a review card will fetch to render one image. */
export const REVIEW_IMAGE_PREVIEW_MAXIMUM_BYTES = 5_000_000;

/** File-name suffix used to decide whether a binary change can be shown. */
export function reviewImageExtension(path: string) {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  const separator = name.lastIndexOf(".");
  return separator >= 0 ? name.slice(separator + 1) : "";
}

/** Reports whether this path is an image the review card can render. */
export function isPreviewableReviewImage(path: string) {
  return PREVIEWABLE_IMAGE_EXTENSIONS.has(reviewImageExtension(path));
}

/** Chooses a media type from the path, then confirms it against the bytes. */
export function reviewImageMediaType(path: string, bytes?: Uint8Array) {
  const expected = PREVIEWABLE_IMAGE_EXTENSIONS.get(reviewImageExtension(path));
  if (!expected) return undefined;
  if (!bytes) return expected;
  const detected = IMAGE_SIGNATURES.find(({ matches }) => matches(bytes));
  return detected?.mediaType === expected ? expected : undefined;
}

/** Builds the authorized preview URL for one binary review unit. */
export function reviewImagePreviewUrl(unitId: string) {
  return `/api/review/images/${encodeURIComponent(unitId)}`;
}
