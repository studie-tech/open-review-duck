import {
  type LanguageAdapter,
  type SupportedLanguage,
  supportedLanguages,
} from "../types";
import { cAdapter } from "./c";
import { cppAdapter } from "./cpp";
import { csharpAdapter } from "./csharp";
import { goAdapter } from "./go";
import { hclAdapter } from "./hcl";
import { javaAdapter } from "./java";
import { javascriptLanguageAdapter } from "./javascript";
import { kotlinAdapter } from "./kotlin";
import { luaAdapter } from "./lua";
import { makefileAdapter } from "./makefile";
import { phpAdapter } from "./php";
import { pythonAdapter } from "./python";
import { rubyAdapter } from "./ruby";
import { rustAdapter } from "./rust";
import { shellAdapter } from "./shell";
import { treeSitterAdapter } from "./tree-sitter-adapter";
import { typescriptAdapter } from "./typescript";

const specializedAdapters = [
  typescriptAdapter,
  javascriptLanguageAdapter,
  pythonAdapter,
  javaAdapter,
  csharpAdapter,
  cppAdapter,
  phpAdapter,
  shellAdapter,
  cAdapter,
  hclAdapter,
  rustAdapter,
  rubyAdapter,
  luaAdapter,
  goAdapter,
  makefileAdapter,
  kotlinAdapter,
] as const satisfies readonly LanguageAdapter[];

const specializedLanguages = new Set<SupportedLanguage>(
  specializedAdapters.map(({ language }) => language),
);

export const languageAdapters: readonly LanguageAdapter[] = [
  ...specializedAdapters,
  ...supportedLanguages
    .filter(
      (language): language is Exclude<SupportedLanguage, "text"> =>
        language !== "text" && !specializedLanguages.has(language),
    )
    .map((language) => treeSitterAdapter(language)),
];

/** Finds the registered parser for a repository path. */
export function languageAdapterForPath(path: string) {
  const normalized = path.toLowerCase();
  const fileName = normalized.split("/").at(-1) ?? normalized;
  return languageAdapters.find(
    ({ extensions, fileNames }) =>
      extensions.some((extension) => normalized.endsWith(extension)) ||
      fileNames?.includes(fileName),
  );
}

/**
 * Finds a parser by an explicit content signature first, then by path.
 *
 * A signature is written to fire only where the name leaves the language open
 * — a shebang on a file with no extension, C++ syntax in a header C and C++
 * both spell `.h` — so reading it first settles those files without taking
 * any file the path already answers for.
 */
export function languageAdapterForFile(
  file: Pick<import("../types").SourceFile, "path" | "content">,
) {
  return (
    languageAdapters.find(({ matches }) => matches?.(file)) ??
    languageAdapterForPath(file.path)
  );
}
