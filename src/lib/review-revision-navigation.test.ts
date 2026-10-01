import { describe, expect, it } from "vitest";
import { reviewIndexAfterRefresh } from "./review-revision-navigation";

const selected = {
  id: "old",
  stableKey: "helper",
  path: "src/b.ts",
  name: "helper",
  startLine: 30,
};
const earlier = { id: "earlier", path: "src/a.ts", startLine: 1 };

describe("navigation across review revisions", () => {
  it("keeps the selected declaration after new ids and ordering changes", () => {
    expect(
      reviewIndexAfterRefresh(
        selected,
        [earlier, { ...selected, id: "new", startLine: 60 }],
        [],
      ),
    ).toBe(1);
  });
  it("follows a renamed file when stable declaration keys change", () => {
    const renamed = {
      ...selected,
      id: "new",
      stableKey: "new-key",
      path: "src/renamed.ts",
    };
    expect(
      reviewIndexAfterRefresh(
        selected,
        [earlier, renamed],
        [{ path: renamed.path, previousPath: selected.path }],
      ),
    ).toBe(1);
  });
  it("keeps the same file and nearest declaration when a unit is removed", () => {
    expect(
      reviewIndexAfterRefresh(
        selected,
        [earlier, { id: "nearby", path: selected.path, startLine: 35 }],
        [],
      ),
    ).toBe(1);
  });
  it("moves to the next tree-order file when the current file disappears", () => {
    expect(
      reviewIndexAfterRefresh(
        selected,
        [{ id: "next", path: "src/c.ts", startLine: 1 }, earlier],
        [],
      ),
    ).toBe(0);
  });
  it("handles an empty review", () => {
    expect(reviewIndexAfterRefresh(selected, [], [])).toBe(0);
  });
});
