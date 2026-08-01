import { supportedExtensions, supportedFileNames } from "../../types";
import { treeSitterAdapter } from "../tree-sitter-adapter";

export const shellExtensions = supportedExtensions.shell;
export const shellFileNames = supportedFileNames.shell;
export const shellAdapter = treeSitterAdapter("shell", {
  matches: ({ content }) =>
    /^#![^\n]*(?:\/|\b)(?:ba|z|k|da)?sh(?:\s|$)/.test(content),
});
export const isContextOnly = shellAdapter.isContextOnly as (
  source: string,
) => boolean;
