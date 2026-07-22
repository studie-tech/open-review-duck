import type { LanguageAdapter } from "../types";
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
import { typescriptAdapter } from "./typescript";

export const languageAdapters: readonly LanguageAdapter[] = [
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

/** Finds a parser by path first, then by an explicit content signature. */
export function languageAdapterForFile(
  file: Pick<import("../types").SourceFile, "path" | "content">,
) {
  return (
    languageAdapterForPath(file.path) ??
    languageAdapters.find(({ matches }) => matches?.(file))
  );
}
