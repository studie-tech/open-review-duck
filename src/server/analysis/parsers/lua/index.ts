import { treeSitterAdapter } from "../tree-sitter-adapter";

export const luaAdapter = treeSitterAdapter("lua");
export const isContextOnly = luaAdapter.isContextOnly as (
  source: string,
) => boolean;
