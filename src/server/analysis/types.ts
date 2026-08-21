import languageManifest from "../../../tree-sitter-languages.json";

export type SupportedLanguage = keyof typeof languageManifest.languages;

interface LanguageDefinition {
  asset?: string;
  source?: string;
  extensions: readonly string[];
  fileNames?: readonly string[];
  lexical?: string;
}

/** A quote-specific interpolation delimiter pair, such as `${` / `}`. */
export interface LexicalInterpolation {
  close: string;
  open: string;
  quotes: readonly string[];
}

/** Comment, string and directive syntax a language can be scanned with. */
export interface LexicalSyntax {
  lineComments: readonly string[];
  blockComments: readonly (readonly [string, string])[];
  interpolations: readonly LexicalInterpolation[];
  quotes: readonly string[];
  directive?: string;
}

interface LexicalInterpolationDefinition {
  close?: string;
  open?: string;
  quotes?: readonly string[];
}

interface LexicalSyntaxDefinition {
  interpolations?: readonly LexicalInterpolationDefinition[];
  lineComments?: readonly string[];
  blockComments?: readonly (readonly string[])[];
  quotes?: readonly string[];
  directive?: string;
}

const languageDefinitions = languageManifest.languages as Record<
  SupportedLanguage,
  LanguageDefinition
>;
const lexicalSyntaxDefinitions = languageManifest.lexicalSyntaxes as Record<
  string,
  LexicalSyntaxDefinition
>;
export const supportedLanguages = Object.keys(
  languageDefinitions,
) as SupportedLanguage[];
export type UnitKind =
  | "constant"
  | "variable"
  | "function"
  | "method"
  | "class"
  | "module"
  | "test"
  | "test_suite"
  | "test_hook"
  | "binary"
  | "file";
type SourceChangeType = "added" | "modified" | "deleted" | "renamed";

export interface ReviewUnitRange {
  startLine?: number;
  endLine?: number;
  previousStartLine?: number;
  previousEndLine?: number;
}

export const supportedExtensions = Object.fromEntries(
  supportedLanguages.map((language) => [
    language,
    languageDefinitions[language].extensions,
  ]),
) as Record<SupportedLanguage, readonly string[]>;

export const supportedFileNames = Object.fromEntries(
  supportedLanguages.flatMap((language) => {
    const fileNames = languageDefinitions[language].fileNames;
    return fileNames ? [[language, fileNames] as const] : [];
  }),
) as Partial<Record<SupportedLanguage, readonly string[]>>;

export const grammarAssets = Object.fromEntries(
  supportedLanguages.flatMap((language) => {
    const asset = languageDefinitions[language].asset;
    return asset ? [[language, asset] as const] : [];
  }),
) as Record<Exclude<SupportedLanguage, "text">, string>;

export const lexicalSyntaxes = Object.fromEntries(
  supportedLanguages.flatMap((language) => {
    const family = languageDefinitions[language].lexical;
    const definition = family ? lexicalSyntaxDefinitions[family] : undefined;
    if (!definition) return [];
    const syntax: LexicalSyntax = {
      lineComments: definition.lineComments ?? [],
      // A pair missing a delimiter, completed with an empty string, would
      // match at every index and leave the highlighter's scan with nowhere to
      // advance to. A malformed pair is dropped instead.
      blockComments: (definition.blockComments ?? []).flatMap((pair) => {
        const [open, close] = pair;
        return open && close ? [[open, close] as const] : [];
      }),
      interpolations: (definition.interpolations ?? []).flatMap(
        (interpolation) => {
          const { close, open, quotes } = interpolation;
          return open && close && quotes && quotes.length > 0
            ? [{ close, open, quotes }]
            : [];
        },
      ),
      quotes: definition.quotes ?? [],
      directive: definition.directive,
    };
    return [[language, syntax] as const];
  }),
) as Partial<Record<SupportedLanguage, LexicalSyntax>>;

/** Returns the lexical syntax declared for a language, when it has one. */
export function lexicalSyntaxFor(language: string) {
  return lexicalSyntaxes[language as SupportedLanguage];
}

/** Checks whether a repository path uses a supported source extension. */
export function isSupportedSourcePath(path: string) {
  const normalized = path.toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return (
    Object.values(supportedExtensions).some((extensions) =>
      extensions.some((extension) => normalized.endsWith(extension)),
    ) ||
    Object.values(supportedFileNames).some((names) =>
      (names as readonly string[]).includes(name),
    )
  );
}

/** Selects complete source files without exceeding the configured byte budget. */
export function applySourceBudget(files: SourceFile[], maximumBytes: number) {
  let usedBytes = 0;
  return files.map((file) => {
    if (file.skipReason) return file;
    const fileBytes =
      Buffer.byteLength(file.content) +
      Buffer.byteLength(file.previousContent ?? "");
    if (usedBytes + fileBytes > maximumBytes) {
      return {
        ...file,
        content: "",
        previousContent: undefined,
        skipReason: "too_large" as const,
      };
    }
    usedBytes += fileBytes;
    return file;
  });
}

export interface SourceFile {
  path: string;
  previousPath?: string;
  content: string;
  previousContent?: string;
  skipReason?: "too_large";
  isBinary?: boolean;
  binaryHash?: string;
  changeType?: SourceChangeType;
}

const binaryExtensions = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".tar",
  ".tiff",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

/** Detects binary files by well-known path or decoded content characteristics. */
export function isLikelyBinaryFile(path: string, content?: string) {
  const normalized = path.toLowerCase();
  if (
    [...binaryExtensions].some((extension) => normalized.endsWith(extension))
  ) {
    return true;
  }
  if (!content) return false;
  const sample = content.slice(0, 8_192);
  if (sample.includes("\0")) return true;
  let suspicious = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (character === "�" || (code < 32 && ![9, 10, 12, 13].includes(code))) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length > 0.01;
}

export interface AnalyzedUnit {
  stableKey: string;
  path: string;
  language: SupportedLanguage;
  kind: UnitKind;
  name: string;
  signature?: string;
  startLine: number;
  endLine: number;
  source: string;
  previousSource?: string;
  previousStartLine?: number;
  previousEndLine?: number;
  contentHash: string;
  semanticHash: string;
  changeType: SourceChangeType;
  complexity: number;
  /** Added and deleted lines owned exclusively by this atomic review unit. */
  changedLineCount: number;
  dependencies: string[];
  relatedRanges?: ReviewUnitRange[];
  /**
   * Where a declaration shown only as its header actually ends.
   *
   * A container is truncated to its header so each member can be signed off on
   * its own, which leaves nothing saying how far the declaration reaches. A
   * revision that introduces the whole declaration needs to know, because then
   * there are no separate members to sign off — only the one new thing.
   */
  bodyEndLine?: number;
  /**
   * Marks a range the analyzer invented rather than a declaration it found.
   *
   * A sweep over statements no declaration claimed, and a fragment of changed
   * lines, each stand for themselves and for nothing around them. A
   * declaration can speak for what it encloses; neither of these can.
   */
  invented?: boolean;
  depth: number;
  reviewOrder: number;
}

export interface AnalysisResult {
  units: AnalyzedUnit[];
  unsupportedFiles: string[];
}

export interface LanguageAdapter {
  language: SupportedLanguage;
  extensions: readonly string[];
  fileNames?: readonly string[];
  /** Detects extensionless language files from a conservative source marker. */
  matches?(file: Pick<SourceFile, "path" | "content">): boolean;
  /**
   * Marks a format whose file is the smallest thing worth signing off, so the
   * engine reviews it whole instead of calling `analyze`.
   */
  reviewsWholeFile?: boolean;
  /** Recognizes language-specific imports, package headers, and inert preamble. */
  isContextOnly?(source: string): boolean;
  /** Extracts reviewable declarations and dependencies from one source file. */
  analyze(
    file: SourceFile,
  ): Omit<AnalyzedUnit, "changedLineCount" | "depth" | "reviewOrder">[];
}
