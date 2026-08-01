import { supportedExtensions, supportedFileNames } from "../../types";
import { treeSitterAdapter } from "../tree-sitter-adapter";

export const makefileExtensions = supportedExtensions.makefile;
export const makefileFileNames = supportedFileNames.makefile;
export const makefileAdapter = treeSitterAdapter("makefile");
export const isContextOnly = makefileAdapter.isContextOnly as (
  source: string,
) => boolean;
