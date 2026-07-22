export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "java"
  | "csharp"
  | "cpp"
  | "php"
  | "shell"
  | "c"
  | "ruby"
  | "hcl"
  | "rust"
  | "lua"
  | "go"
  | "makefile"
  | "kotlin"
  | "text";

export const supportedLanguages = [
  "javascript",
  "typescript",
  "python",
  "java",
  "csharp",
  "cpp",
  "php",
  "shell",
  "c",
  "ruby",
  "hcl",
  "rust",
  "lua",
  "go",
  "makefile",
  "kotlin",
  "text",
] as const satisfies readonly SupportedLanguage[];
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
export type SourceChangeType = "added" | "modified" | "deleted" | "renamed";

export const supportedExtensions = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"],
  java: [".java"],
  csharp: [".cs", ".csx"],
  cpp: [
    ".cpp",
    ".cc",
    ".cxx",
    ".c++",
    ".hpp",
    ".hh",
    ".hxx",
    ".h++",
    ".ipp",
    ".tpp",
    ".inl",
  ],
  php: [".php", ".phtml", ".inc"],
  shell: [".sh", ".bash", ".zsh", ".ksh"],
  c: [".c", ".h"],
  ruby: [".rb", ".rake", ".gemspec"],
  hcl: [".hcl", ".tf", ".tfvars"],
  rust: [".rs"],
  lua: [".lua"],
  go: [".go"],
  makefile: [".mk"],
  kotlin: [".kt", ".kts"],
  text: [],
} as const satisfies Record<SupportedLanguage, readonly string[]>;

export const supportedFileNames = {
  shell: [".bashrc", ".zshrc", ".profile"],
  ruby: ["rakefile", "gemfile"],
  makefile: ["makefile", "gnumakefile"],
} as const satisfies Partial<Record<SupportedLanguage, readonly string[]>>;

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
  contentHash: string;
  semanticHash: string;
  changeType: SourceChangeType;
  complexity: number;
  dependencies: string[];
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
  /** Recognizes language-specific imports, package headers, and inert preamble. */
  isContextOnly?(source: string): boolean;
  /** Extracts reviewable declarations and dependencies from one source file. */
  analyze(file: SourceFile): Omit<AnalyzedUnit, "depth" | "reviewOrder">[];
}
