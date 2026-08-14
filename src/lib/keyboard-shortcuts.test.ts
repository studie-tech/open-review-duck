// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  commandMenuShortcut,
  formatShortcut,
  isActivatableTarget,
  isApplePlatform,
  isEditableTarget,
  matchesShortcutStroke,
  shortcutHelpShortcut,
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

  it("leaves Enter to whatever control already answers it", () => {
    /** Builds one input of the given type for the activation check. */
    function inputOfType(type: string) {
      const element = document.createElement("input");
      element.setAttribute("type", type);
      return element;
    }
    const link = document.createElement("a");
    link.setAttribute("href", "/dashboard");
    const plainAnchor = document.createElement("a");
    const label = document.createElement("span");
    document.createElement("button").append(label);

    expect(isActivatableTarget(document.createElement("button"))).toBe(true);
    expect(isActivatableTarget(document.createElement("summary"))).toBe(true);
    expect(isActivatableTarget(link)).toBe(true);
    // The event target is whatever the pointer or focus ring lands on, which
    // for a labelled control is the text inside it rather than the control.
    expect(isActivatableTarget(label)).toBe(true);
    for (const type of ["button", "image", "reset", "submit"]) {
      expect(isActivatableTarget(inputOfType(type))).toBe(true);
    }

    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitem");
    expect(isActivatableTarget(menuItem)).toBe(true);

    expect(isActivatableTarget(inputOfType("text"))).toBe(false);
    expect(isActivatableTarget(plainAnchor)).toBe(false);
    expect(isActivatableTarget(document.createElement("div"))).toBe(false);
    expect(isActivatableTarget(null)).toBe(false);
  });

  it("keeps global launchers clear of browser-reserved modifier shortcuts", () => {
    expect(commandMenuShortcut).toEqual([{ key: "q" }]);
    expect(shortcutHelpShortcut).toEqual([{ key: "?" }]);
  });
});
