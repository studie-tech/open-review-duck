import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TreeSitterLanguage } from "./tree-sitter";
import { withPreparedTreeSitterLanguages, withSyntaxTree } from "./tree-sitter";

const luaSource = `local Account = {}
Account.__index = Account

local DEFAULT_BALANCE = 0

local function assert_positive(amount)
  return amount
end

function Account.new(owner)
  return setmetatable({}, Account)
end

return Account
`;

describe("probe", () => {
  it("repeats parsing", async () => {
    const out: string[] = [];
    await withPreparedTreeSitterLanguages(["lua" as TreeSitterLanguage], () => {
      for (let pass = 1; pass <= 3; pass += 1) {
        withSyntaxTree("lua", luaSource, (tree) => {
          out.push(`\n-- pass ${pass} --`);
          for (const child of tree.rootNode.namedChildren) {
            if (!child) continue;
            out.push(
              `${child.type} [${child.startPosition.row + 1}-${child.endPosition.row + 1}] name=${child.childForFieldName("name")?.text ?? "<null>"}`,
            );
          }
        });
      }
    });
    writeFileSync("/tmp/probe-dyn.txt", out.join("\n"));
    expect(out.length).toBeGreaterThan(0);
  });
});
