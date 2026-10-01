"use client";

import {
  cloneElement,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import {
  formatShortcut,
  isApplePlatform,
  type KeyboardShortcut,
} from "~/lib/keyboard-shortcuts";

const ModifierHeldContext = createContext(false);

/** Reveals toolbar key hints only while the platform command modifier is held. */
export function ReviewToolbar({ children }: { children: ReactNode }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const apple = isApplePlatform();
    /** Tracks both modifier presses and release events after a shortcut. */
    function update(event: KeyboardEvent) {
      setHeld(apple ? event.metaKey : event.ctrlKey);
    }
    /** Clears hints when the browser loses focus or the tab is hidden. */
    function clear() {
      setHeld(false);
    }
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);
  return (
    <ModifierHeldContext.Provider value={held}>
      <fieldset
        className="flex shrink-0 items-center gap-1"
        aria-label="Review actions"
      >
        {children}
      </fieldset>
    </ModifierHeldContext.Provider>
  );
}

/** Shows the same compact action hint on hover and keyboard focus. */
export function ReviewToolbarTooltip({
  label,
  children,
  shortcut,
}: {
  label: string;
  shortcut?: KeyboardShortcut;
  children: ReactElement<{
    "aria-describedby"?: string;
    "aria-keyshortcuts"?: string;
    title?: string;
  }>;
}) {
  const held = useContext(ModifierHeldContext);
  const [apple, setApple] = useState(false);
  useEffect(() => setApple(isApplePlatform()), []);
  const keys = shortcut
    ? formatShortcut(shortcut, apple).join(" then ")
    : undefined;
  const ariaKeys = shortcut
    ?.map((stroke) =>
      [
        stroke.mod ? (apple ? "Meta" : "Control") : undefined,
        stroke.shift ? "Shift" : undefined,
        stroke.alt ? "Alt" : undefined,
        stroke.key,
      ]
        .filter(Boolean)
        .join("+"),
    )
    .join(" ");
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper handles hover and bubbled focus/Escape for its interactive child
    <div
      className="relative flex shrink-0 items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      {cloneElement(children, {
        "aria-describedby":
          [children.props["aria-describedby"], open && !held ? id : undefined]
            .filter(Boolean)
            .join(" ") || undefined,
        title: undefined,
        "aria-keyshortcuts": ariaKeys,
      })}
      {held && keys && (
        <kbd className="mr-1 rounded-md border border-line-strong bg-surface-subtle px-1.5 py-1 font-mono text-[10px] leading-none text-mist">
          {keys}
        </kbd>
      )}
      {open && !held && (
        <div
          id={id}
          role="tooltip"
          className="absolute right-0 top-full z-50 w-max max-w-64 pt-2"
        >
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-normal text-cloud shadow-lg">
            {label}
            {keys ? ` (${keys})` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
