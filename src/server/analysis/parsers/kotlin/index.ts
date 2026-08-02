import { treeSitterAdapter } from "../tree-sitter-adapter";

export const kotlinAdapter = treeSitterAdapter("kotlin");
export const isContextOnly = kotlinAdapter.isContextOnly as (
  source: string,
) => boolean;
