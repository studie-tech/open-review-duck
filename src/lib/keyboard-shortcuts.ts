export type ShortcutStroke = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type KeyboardShortcut = ShortcutStroke[];

/** Checks whether keyboard hints should use Apple modifier symbols. */
export function isApplePlatform(userAgent?: string) {
  const agent =
    userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  return /Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(agent);
}

/** Checks whether a keyboard event originated in an editable control. */
export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ),
  );
}

/** Checks whether a keyboard event matches a shortcut stroke. */
export function matchesShortcutStroke(
  event: KeyboardEvent,
  stroke: ShortcutStroke,
) {
  const modifier = event.metaKey || event.ctrlKey;
  return (
    event.key.toLowerCase() === stroke.key.toLowerCase() &&
    modifier === Boolean(stroke.mod) &&
    event.shiftKey === Boolean(stroke.shift) &&
    event.altKey === Boolean(stroke.alt)
  );
}

/** Formats a shortcut sequence for the current operating system. */
export function formatShortcut(
  shortcut: KeyboardShortcut,
  apple = isApplePlatform(),
) {
  return shortcut.map((stroke) => {
    const modifiers = [
      stroke.mod ? (apple ? "⌘" : "Ctrl") : undefined,
      stroke.alt ? (apple ? "⌥" : "Alt") : undefined,
      stroke.shift ? (apple ? "⇧" : "Shift") : undefined,
    ].filter(Boolean);
    const key =
      stroke.key === "Enter"
        ? apple
          ? "↵"
          : "Enter"
        : stroke.key === "Escape"
          ? "Esc"
          : stroke.key === "ArrowUp"
            ? "↑"
            : stroke.key === "ArrowDown"
              ? "↓"
              : stroke.key === "ArrowLeft"
                ? "←"
                : stroke.key === "ArrowRight"
                  ? "→"
                  : stroke.key.length === 1
                    ? stroke.key.toUpperCase()
                    : stroke.key;
    return [...modifiers, key].join(apple ? "" : "+");
  });
}

// Global page shortcuts intentionally avoid browser-reserved modifier chords.
export const commandMenuShortcut: KeyboardShortcut = [{ key: "q" }];

export const shortcutHelpShortcut: KeyboardShortcut = [{ key: "?" }];
