import { treeSitterAdapter } from "../tree-sitter-adapter";

export const hclAdapter = treeSitterAdapter("hcl");
export const isContextOnly = hclAdapter.isContextOnly as (
  source: string,
) => boolean;
