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

/** Languages whose review payload is authored Markdown, not executable source. */
const MARKDOWN_REVIEW_LANGUAGES = new Set(["markdown", "mdx"]);

/** Extensions that should open the Markdown preview instead of raw source. */
const MARKDOWN_REVIEW_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
/** SQL dumps start folded by size; ordinary SQL migrations stay readable. */
export const HEAVY_SQL_SOURCE_BYTES = 64 * 1024;

/** Returns the lowercase file extension of a repository path. */
export function reviewPathExtension(path: string) {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Reports whether a review file is Markdown the reviewer can read rendered.
 *
 * Language wins when analysis stored `markdown` or `mdx`. Otherwise the
 * path extension covers files that arrived as plain text.
 */
export function isReviewMarkdownFile(input: {
  language?: string;
  path?: string;
}) {
  const language = (input.language ?? "").trim().toLowerCase();
  if (MARKDOWN_REVIEW_LANGUAGES.has(language)) return true;
  return MARKDOWN_REVIEW_EXTENSIONS.has(reviewPathExtension(input.path ?? ""));
}

/** Identifies Jupyter notebooks independently of their JSON parser language. */
export function isReviewNotebookFile(input: { path?: string }) {
  return reviewPathExtension(input.path ?? "") === "ipynb";
}

/** Identifies documents with a rendered presentation and a Raw source view. */
export function isReviewPreviewFile(input: {
  language?: string;
  path?: string;
}) {
  return isReviewMarkdownFile(input) || isReviewNotebookFile(input);
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
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
 * before private source hydrates. Falls back to the source's UTF-8 byte length.
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
  return new TextEncoder().encode(source).byteLength;
}

/**
 * Reports data documents and SQL dumps that should start folded.
 *
 * Small configs and SQL migrations stay open. Stored byte sizes let large
 * documents fold before their private source has hydrated.
 */
export function isHeavyReviewSource(input: {
  changedLineCount?: number;
  language?: string;
  path?: string;
  source?: string;
  sourceBytes?: number;
}) {
  const sql =
    reviewPathExtension(input.path ?? "") === "sql" ||
    input.language?.trim().toLowerCase() === "sql";
  const data =
    isDataOrGeneratedReviewPath(input.path ?? "") ||
    isDataReviewLanguage(input.language);
  if (!sql && !data) return false;
  const threshold = sql ? HEAVY_SQL_SOURCE_BYTES : HEAVY_DATA_SOURCE_BYTES;
  // UTF-8 is at least as long as its UTF-16 input. Avoid encoding documents
  // already known to exceed the threshold, especially full SQL dumps.
  if (
    Math.max(input.sourceBytes ?? 0, input.source?.length ?? 0) >= threshold
  ) {
    return true;
  }
  const changedLineCount =
    input.changedLineCount ?? reviewSourceLineCount(input.source ?? "");
  if (data && changedLineCount >= HEAVY_DATA_CHANGE_LINES) return true;
  return (reviewSourceByteLength({ source: input.source }) ?? 0) >= threshold;
}

/**
 * Chooses whether a file card should mount its source on first paint.
 *
 * Reviewed cards fold so finished work stops competing for attention.
 * Heavy data files start folded so opening the review does not paint
 * thousands of JSON rows before the reviewer has asked to see them.
 * A later sidebar pick can open the selected card without rewriting
 * this default; see `selectedReviewFileCardExpanded`.
 */
export function reviewFileCardStartsExpanded(input: {
  heavy: boolean;
  reviewed: boolean;
}) {
  return !input.reviewed && !input.heavy;
}

/**
 * Reports whether the selected file card should show its source.
 *
 * The chevron and "Show file" write an explicit reveal for this path and
 * reviewed state; that choice wins. Choosing the file from the sidebar is
 * a request to read it, so inspection opens the card until the reviewer
 * leaves or folds it again. Otherwise the card uses its first-paint default.
 */
export function selectedReviewFileCardExpanded(input: {
  defaultExpanded: boolean;
  inspected: boolean;
  path: string;
  reviewed: boolean;
  reveal?: { expanded: boolean; path: string; reviewed: boolean };
}) {
  if (
    input.reveal &&
    input.reveal.path === input.path &&
    input.reveal.reviewed === input.reviewed
  ) {
    return input.reveal.expanded;
  }
  if (input.inspected) return true;
  return input.defaultExpanded;
}
