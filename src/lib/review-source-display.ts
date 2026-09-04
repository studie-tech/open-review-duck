/** Data-document languages whose source is usually a dump, not logic. */
const DATA_REVIEW_LANGUAGES = new Set(["json", "json5", "yaml", "toml", "xml"]);

/** Extensions that almost always carry generated or serialized data. */
const DATA_REVIEW_EXTENSIONS = new Set([
  "json",
  "json5",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "lock",
]);

/**
 * Changed-line count at which a data document starts folded.
 *
 * A small config file is still worth reading. A drizzle snapshot or lockfile
 * with a broad change is usually better left closed until it is requested.
 */
export const HEAVY_DATA_CHANGE_LINES = 30;

/** Byte size that hides a data document even when it is mostly one line. */
export const HEAVY_DATA_SOURCE_BYTES = 16 * 1024;

/** Returns the lowercase file extension of a repository path. */
export function reviewPathExtension(path: string) {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Reports whether a path is serialized data rather than reviewable logic.
 *
 * JSON, lockfiles, and snapshots are the files that turn Files mode into a
 * wall of highlighted rows. Small configs still use these extensions, so
 * callers pair this with a size check before hiding anything.
 */
export function isDataOrGeneratedReviewPath(path: string) {
  const extension = reviewPathExtension(path);
  if (DATA_REVIEW_EXTENSIONS.has(extension)) return true;
  const name = (path.split("/").pop() ?? "").toLowerCase();
  return name.endsWith(".lock");
}

/** Reports whether a stored review language is a data document. */
function isDataReviewLanguage(language: string | undefined) {
  return DATA_REVIEW_LANGUAGES.has((language ?? "").trim().toLowerCase());
}

/** Counts source lines without allocating a line array the caller will discard. */
export function reviewSourceLineCount(source: string) {
  if (!source) return 0;
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/**
 * Names the kind of source a collapsed card is hiding.
 *
 * The label is for the placeholder, not for syntax highlighting, so an
 * unknown language falls back to the path extension and then to "source".
 */
export function reviewSourceKindLabel(input: {
  language?: string;
  path?: string;
}) {
  const language = input.language?.trim().toLowerCase();
  if (language && language !== "text") return language;
  return reviewPathExtension(input.path ?? "") || "source";
}

/** Formats a source payload size for the collapsed-file placeholder. */
export function formatReviewSourceBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Placeholder copy stored when a file's bytes are not kept for review. */
const REVIEW_SOURCE_PLACEHOLDERS = new Set([
  "Binary file — content is not displayed.",
  "File content is too large to display safely.",
]);

/**
 * Returns known source bytes for a file or unit range.
 *
 * Prefers the stored UTF-8 range (`endByte - startByte`), which is available
 * before private source hydrates. Falls back to a real source string's length.
 * Empty ranges, missing source, and analysis placeholders are unknown.
 */
export function reviewSourceByteLength(input?: {
  endByte?: number | null;
  source?: string | null;
  startByte?: number | null;
}) {
  if (!input) return undefined;
  const start = input.startByte ?? 0;
  const end = input.endByte ?? 0;
  if (end > start) return end - start;
  const source = input.source ?? "";
  if (!source || REVIEW_SOURCE_PLACEHOLDERS.has(source)) return undefined;
  return source.length;
}

/**
 * Reports source that would stall the review UI if every line were mounted.
 *
 * Only data documents auto-hide: a large TypeScript file is still the work
 * the reviewer came to read. JSON dumps are not.
 */
export function isHeavyReviewSource(input: {
  changedLineCount?: number;
  language?: string;
  path?: string;
  source?: string;
}) {
  if (
    !isDataOrGeneratedReviewPath(input.path ?? "") &&
    !isDataReviewLanguage(input.language)
  ) {
    return false;
  }
  const changedLineCount =
    input.changedLineCount ?? reviewSourceLineCount(input.source ?? "");
  if (changedLineCount >= HEAVY_DATA_CHANGE_LINES) return true;
  const bytes = input.source?.length ?? 0;
  return bytes >= HEAVY_DATA_SOURCE_BYTES;
}

/**
 * Chooses whether a file card should mount its source on first paint.
 *
 * Reviewed cards fold so finished work stops competing for attention.
 * Heavy data files start folded so opening the review does not paint
 * thousands of JSON rows before the reviewer has asked to see them.
 */
export function reviewFileCardStartsExpanded(input: {
  heavy: boolean;
  reviewed: boolean;
}) {
  return !input.reviewed && !input.heavy;
}
