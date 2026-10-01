import { describe, expect, it, vi } from "vitest";
import { reviewShortcuts } from "~/lib/review-shortcuts";
import { buildReviewStepCommands } from "./review-workspace-commands";

/** Builds mode-specific navigation commands with observable actions. */
function navigationCommands(reviewMode: "files" | "path") {
  const navigateCard = vi.fn();
  const navigateConcept = vi.fn();
  const commands = buildReviewStepCommands({
    activeCardIndex: 1,
    activeConceptIndex: 1,
    cardCount: 3,
    conceptCount: 3,
    navigateCard,
    navigateConcept,
    reviewMode,
  });

  return { commands, navigateCard, navigateConcept };
}

describe("buildReviewStepCommands", () => {
  it("exposes only file navigation in Files mode", () => {
    const { commands, navigateCard, navigateConcept } =
      navigationCommands("files");

    expect(commands.map(({ id }) => id)).toEqual([
      "next-unit",
      "previous-unit",
    ]);
    expect(commands.map(({ label }) => label)).toEqual([
      "Select next file",
      "Select previous file",
    ]);
    expect(commands.map(({ shortcut }) => shortcut)).toEqual([
      reviewShortcuts.nextUnit,
      reviewShortcuts.previousUnit,
    ]);

    commands[0]?.onSelect();
    commands[1]?.onSelect();
    expect(navigateCard).toHaveBeenNthCalledWith(1, 1);
    expect(navigateCard).toHaveBeenNthCalledWith(2, -1);
    expect(navigateConcept).not.toHaveBeenCalled();
  });

  it("retains card and concept navigation in Guided mode", () => {
    const { commands, navigateConcept } = navigationCommands("path");

    expect(commands.map(({ id }) => id)).toEqual([
      "next-unit",
      "previous-unit",
      "next-concept",
      "previous-concept",
    ]);
    expect(commands.map(({ label }) => label)).toEqual([
      "Select next card",
      "Select previous card",
      "Open next concept",
      "Open previous concept",
    ]);
    expect(commands.slice(2).map(({ shortcut }) => shortcut)).toEqual([
      reviewShortcuts.nextConcept,
      reviewShortcuts.previousConcept,
    ]);

    commands[2]?.onSelect();
    commands[3]?.onSelect();
    expect(navigateConcept).toHaveBeenNthCalledWith(1, 1);
    expect(navigateConcept).toHaveBeenNthCalledWith(2, -1);
  });
});
