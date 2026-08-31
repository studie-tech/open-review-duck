// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionableReviewCardMember,
  CopyReviewPathButton,
  ReviewFileCardHeader,
  ReviewFileUnitMarker,
  reviewCardRanges,
  reviewedFileCard,
} from "./review-file-card";

afterEach(cleanup);

const units = [
  {
    id: "configuration",
    path: "src/preview.ts",
    name: "configuration",
    changedLineCount: 1,
    changeType: "added",
    previousSource: null,
    source: "const configuration = true;",
    startLine: 2,
    endLine: 2,
    language: "typescript",
    kind: "constant",
    status: "pending",
  },
  {
    id: "main",
    path: "src/preview.ts",
    name: "main",
    changedLineCount: 1,
    changeType: "added",
    previousSource: null,
    source: "const main = true;",
    startLine: 5,
    endLine: 5,
    language: "typescript",
    kind: "constant",
    status: "pending",
  },
] as const;

describe("file card review state", () => {
  it("opens the first actionable member in a partially reviewed card", () => {
    expect(
      actionableReviewCardMember([
        { id: "done", status: "signed_off" },
        { id: "held", status: "waiting" },
        { id: "next", status: "pending" },
      ])?.id,
    ).toBe("next");
  });

  it("opens a new unit added after a revision in a partially reviewed card", () => {
    const members = [
      { id: "old", status: "signed_off", revisionState: "unchanged" },
      { id: "added", status: "pending", revisionState: "new" },
    ];

    expect(actionableReviewCardMember(members)?.id).toBe("added");
    expect(reviewedFileCard(members)).toBe(false);
  });

  it("opens an updated unit that needs re-review before signed-off siblings", () => {
    expect(
      actionableReviewCardMember([
        { id: "old", status: "signed_off", revisionState: "unchanged" },
        { id: "rewritten", status: "changed", revisionState: "updated" },
      ])?.id,
    ).toBe("rewritten");
    expect(
      reviewedFileCard([
        { status: "signed_off", revisionState: "unchanged" },
        { status: "changed", revisionState: "updated" },
      ]),
    ).toBe(false);
  });

  it("does not treat a signed-off new unit as still outstanding", () => {
    expect(
      reviewedFileCard([
        { status: "signed_off", revisionState: "unchanged" },
        { status: "signed_off", revisionState: "new" },
      ]),
    ).toBe(true);
    expect(
      actionableReviewCardMember([
        { id: "old", status: "signed_off", revisionState: "unchanged" },
        { id: "added", status: "signed_off", revisionState: "new" },
      ])?.id,
    ).toBe("old");
  });
});

describe("reviewCardRanges", () => {
  it("keeps the gap between two members outside both atomic ranges", () => {
    expect(reviewCardRanges([units[0], units[1]] as never)).toEqual([
      { startLine: 2, endLine: 2 },
      { startLine: 5, endLine: 5 },
    ]);
  });

  it("maps modified members to their shifted base-side lines", () => {
    const member = {
      ...units[0],
      changeType: "modified",
      previousSource: "const configuration = false;",
      previousStartByte: 12,
      startLine: 3,
      endLine: 3,
    } as never;

    expect(
      reviewCardRanges(
        [member],
        "previous",
        "// removed\nconst configuration = false;",
      ),
    ).toEqual([{ startLine: 2, endLine: 2 }]);
  });
});

describe("ReviewFileCardHeader", () => {
  it("excludes waiting members from the card action count", () => {
    render(
      <ReviewFileCardHeader
        members={[units[0], { ...units[1], status: "waiting" }] as never}
        index={0}
        count={1}
        selected
      />,
    );

    expect(screen.getByText("1 remaining")).toBeInTheDocument();
    expect(screen.queryByText("Reviewed")).not.toBeInTheDocument();
  });

  it("does not show Reviewed when a new-since-sync unit is still outstanding", () => {
    render(
      <ReviewFileCardHeader
        members={
          [
            { ...units[0], status: "signed_off", revisionState: "unchanged" },
            { ...units[1], status: "pending", revisionState: "new" },
          ] as never
        }
        index={0}
        count={1}
        selected
      />,
    );

    expect(screen.queryByText("Reviewed")).not.toBeInTheDocument();
    expect(screen.getByText("1 remaining")).toBeInTheDocument();
  });

  it("can label a files-mode card as a file in the stack", () => {
    render(
      <ReviewFileCardHeader
        members={[units[0]] as never}
        index={3}
        count={12}
        selected={false}
        itemLabel="File"
        sourceBytes={2_048}
      />,
    );

    expect(screen.getByText("File 4/12")).toBeInTheDocument();
    expect(screen.queryByText("Card 4/12")).not.toBeInTheDocument();
    expect(screen.getByText(/in this file/)).toBeInTheDocument();
    expect(screen.queryByText(/in this card/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Reviewing 1 individual unit in this file · 1 changed lines · 2 KB",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Select review file for src/preview.ts",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy file path" }),
    ).toBeInTheDocument();
  });

  it("shows the file size on a binary file card header", () => {
    render(
      <ReviewFileCardHeader
        members={
          [
            {
              ...units[0],
              path: "assets/farming/farm-background-v2.png",
              name: "farm-background-v2.png",
              kind: "binary",
              language: "text",
              source: "Binary file — content is not displayed.",
            },
          ] as never
        }
        index={0}
        count={4}
        selected
        itemLabel="File"
        sourceBytes={1_200_000}
      />,
    );

    expect(
      screen.getByText(
        "Reviewing 1 individual unit in this file · 1 changed lines · 1.1 MB",
      ),
    ).toBeInTheDocument();
  });

  it("omits file size from the card subtitle when the size is unknown", () => {
    render(
      <ReviewFileCardHeader
        members={[units[0]] as never}
        index={0}
        count={1}
        selected={false}
        itemLabel="File"
      />,
    );

    expect(
      screen.getByText(
        "Reviewing 1 individual unit in this file · 1 changed lines",
      ),
    ).toBeInTheDocument();
  });

  it("copies the card path without selecting the card", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onSelect = vi.fn();
    render(
      <ReviewFileCardHeader
        members={[units[0]] as never}
        index={0}
        count={1}
        selected={false}
        itemLabel="File"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy file path" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("src/preview.ts");
    });
    expect(
      screen.getByRole("button", { name: "File path copied" }),
    ).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("CopyReviewPathButton", () => {
  /** Installs a clipboard the jsdom navigator does not expose. */
  function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  }

  it("puts the file path on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render(
      <CopyReviewPathButton path="app/public/layouts/farming/farm-background-v2.png" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy file path" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "app/public/layouts/farming/farm-background-v2.png",
      );
    });
    expect(
      screen.getByRole("button", { name: "File path copied" }),
    ).toBeInTheDocument();
  });

  it("says so when the clipboard refuses the path", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast");
    mockClipboard(writeText);
    render(<CopyReviewPathButton path="src/preview.ts" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy file path" }));

    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Could not copy the file path");
    });
    expect(
      screen.getByRole("button", { name: "Copy file path" }),
    ).toBeInTheDocument();
  });
});

describe("ReviewFileUnitMarker", () => {
  it("labels the unit as a section with its line span instead of a card title", () => {
    render(
      <ReviewFileUnitMarker
        member={
          {
            id: "type-plot",
            name: "TypePlot",
            startLine: 9908,
            endLine: 9936,
            status: "pending",
            revisionState: "unchanged",
          } as never
        }
      />,
    );

    expect(screen.queryByText("Review unit")).not.toBeInTheDocument();
    expect(screen.getByText("TypePlot")).toBeInTheDocument();
    expect(screen.getByText("L9908–9936")).toBeInTheDocument();
    expect(screen.getByText("Not reviewed")).toBeInTheDocument();
    expect(
      screen.getByText("TypePlot").closest("[data-review-unit-start]"),
    ).toHaveAttribute("data-review-unit-start", "type-plot");
  });
});
