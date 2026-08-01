import { supportedExtensions, supportedFileNames } from "../../types";
import { treeSitterAdapter } from "../tree-sitter-adapter";

export const rubyExtensions = supportedExtensions.ruby;
export const rubyFileNames = supportedFileNames.ruby;
export const rubyAdapter = treeSitterAdapter("ruby", {
  matches: ({ content }) => /^#![^\n]*\bruby(?:\s|$)/.test(content),
});
export const isContextOnly = rubyAdapter.isContextOnly as (
  source: string,
) => boolean;
