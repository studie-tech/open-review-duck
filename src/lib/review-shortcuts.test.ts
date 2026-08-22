import { describe, expect, it } from "vitest";
import { commandMenuShortcut } from "~/lib/keyboard-shortcuts";
import {
  cockpitShortcuts,
  readerShortcuts,
  reviewShortcuts,
} from "./review-shortcuts";

/** Collects every first stroke that starts a shortcut sequence. */
function leadingKeys(shortcuts: Record<string, unknown>) {
  const keys = new Set<string>();
  for (const shortcut of Object.values(shortcuts)) {
    const strokes = shortcut as Array<{ key: string }>;
    const first = strokes[0]?.key;
    if (first) keys.add(first.toLowerCase());
  }
  return keys;
}

describe("review shortcuts", () => {
  it("never starts a sequence with a shell-reserved stroke", () => {
    const reserved = new Set<string>(["?"]);
    const commandKey = commandMenuShortcut[0]?.key;
    if (commandKey) reserved.add(commandKey.toLowerCase());
    for (const map of [reviewShortcuts, readerShortcuts, cockpitShortcuts]) {
      for (const key of leadingKeys(map)) {
        expect(reserved.has(key)).toBe(false);
      }
    }
  });

  it("keeps the repository reader aligned with the pull-request workspace", () => {
    expect(readerShortcuts.signOff).toEqual(reviewShortcuts.signOff);
    expect(readerShortcuts.nextPending).toEqual(reviewShortcuts.nextPending);
    expect(readerShortcuts.search).toEqual(reviewShortcuts.search);
    expect(readerShortcuts.scrollUp).toEqual(reviewShortcuts.scrollUp);
    expect(readerShortcuts.scrollDown).toEqual(reviewShortcuts.scrollDown);
    expect(readerShortcuts.togglePathPanel).toEqual(
      reviewShortcuts.togglePathPanel,
    );
    expect(readerShortcuts.nextUnit).toEqual(reviewShortcuts.nextUnit);
    expect(readerShortcuts.previousUnit).toEqual(reviewShortcuts.previousUnit);
  });

  it("gives the cockpit one stroke per section", () => {
    expect(cockpitShortcuts.overview).toEqual([{ key: "1" }]);
    expect(cockpitShortcuts.findings).toEqual([{ key: "2" }]);
    expect(cockpitShortcuts.rules).toEqual([{ key: "3" }]);
    expect(cockpitShortcuts.history).toEqual([{ key: "4" }]);
  });
});
