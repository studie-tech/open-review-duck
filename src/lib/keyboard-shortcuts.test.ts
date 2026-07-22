// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  formatShortcut,
  isApplePlatform,
  isEditableTarget,
  matchesShortcutStroke,
} from "./keyboard-shortcuts";

describe("keyboard shortcuts", () => {
  it("formats the primary modifier for Apple and non-Apple platforms", () => {
    const shortcut = [{ key: "k", mod: true }];

    expect(formatShortcut(shortcut, true)).toEqual(["⌘K"]);
    expect(formatShortcut(shortcut, false)).toEqual(["Ctrl+K"]);
    expect(isApplePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(
      true,
    );
    expect(isApplePlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });

  it("formats directional shortcuts as arrows", () => {
    expect(
      formatShortcut([{ key: "ArrowLeft" }, { key: "ArrowRight" }], false),
    ).toEqual(["←", "→"]);
  });

  it("matches either operating-system modifier without matching bare keys", () => {
    expect(
      matchesShortcutStroke(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        { key: "k", mod: true },
      ),
    ).toBe(true);
    expect(
      matchesShortcutStroke(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
        { key: "k", mod: true },
      ),
    ).toBe(true);
    expect(
      matchesShortcutStroke(new KeyboardEvent("keydown", { key: "k" }), {
        key: "k",
        mod: true,
      }),
    ).toBe(false);
  });

  it("recognizes typing surfaces where action shortcuts must be suppressed", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const contentEditable = document.createElement("div");
    contentEditable.setAttribute("contenteditable", "true");
    const customEditor = document.createElement("div");
    customEditor.setAttribute("role", "textbox");
    const button = document.createElement("button");

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(contentEditable)).toBe(true);
    expect(isEditableTarget(customEditor)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
  });
});
