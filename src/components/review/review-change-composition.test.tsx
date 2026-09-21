// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { reviewFileEntries } from "~/lib/review-files";
import { ReviewChangeComposition } from "./review-change-composition";

afterEach(cleanup);

/** One changed-file manifest row with sensible defaults. */
function manifestFile(
  id: string,
  changeType: string,
  overrides: Partial<{
    previousPath: string | null;
    additions: number;
    deletions: number;
  }> = {},
) {
  return {
    id,
    path: `src/${id}.ts`,
    previousPath: null,
    changeType,
    additions: changeType === "deleted" ? 0 : 3,
    deletions: changeType === "deleted" ? 3 : 0,
    isBinary: false,
    skipReason: null,
    ...overrides,
  };
}

describe("ReviewChangeComposition", () => {
  it("describes how many files each kind of revision accounts for", () => {
    const files = reviewFileEntries(
      [
        manifestFile("moved", "renamed", {
          previousPath: "lib/moved.ts",
          additions: 0,
          deletions: 0,
        }),
        manifestFile("edited-move", "renamed", {
          previousPath: "lib/edited-move.ts",
        }),
        manifestFile("changed", "modified"),
        manifestFile("fresh", "added"),
      ],
      [
        {
          id: "edited",
          path: "src/edited-move.ts",
          status: "pending",
          revisionState: "initial",
        },
      ],
    );
    render(<ReviewChangeComposition files={files} />);

    expect(
      screen.getByRole("img", {
        name: "Changed files by kind: 1 moved unchanged, 1 moved + edited, 1 modified, 1 added",
      }),
    ).toBeVisible();
    expect(screen.queryByText("deleted")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty revision", () => {
    const { container } = render(<ReviewChangeComposition files={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
