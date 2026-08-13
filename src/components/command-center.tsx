"use client";

import { Search, X } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { modalSurfaceClassName } from "~/components/ui/modal-surface";
import {
  commandMenuShortcut,
  formatShortcut,
  isApplePlatform,
  isEditableTarget,
  type KeyboardShortcut,
  matchesShortcutStroke,
  shortcutHelpShortcut,
} from "~/lib/keyboard-shortcuts";
import { cn } from "~/lib/utils";

export type CommandCenterItem = {
  id: string;
  label: string;
  description?: string;
  group: string;
  keywords?: string[];
  icon?: ReactNode;
  shortcut?: KeyboardShortcut;
  alternateShortcut?: KeyboardShortcut;
  disabled?: boolean;
  searchOnly?: boolean;
  onSelect: () => void;
};

export type CommandCenterMode = "commands" | "shortcuts";

const SHORTCUT_SEQUENCE_TIMEOUT_MS = 3_000;
const AMBIGUOUS_SHORTCUT_TIMEOUT_MS = 850;

export type PendingShortcutSequence = {
  prefix: KeyboardShortcut;
  fallbackLabel?: string;
  options: Array<{
    label: string;
    stroke: KeyboardShortcut[number];
    disabled: boolean;
  }>;
};

type CommandBinding = {
  bindingId: string;
  command: CommandCenterItem;
  shortcut: KeyboardShortcut;
};

/** Expands primary and alternate command shortcuts into matchable bindings. */
function commandBindings(commands: CommandCenterItem[]) {
  return commands.flatMap((command): CommandBinding[] => [
    ...(command.shortcut
      ? [
          {
            bindingId: `${command.id}:primary`,
            command,
            shortcut: command.shortcut,
          },
        ]
      : []),
    ...(command.alternateShortcut
      ? [
          {
            bindingId: `${command.id}:alternate`,
            command,
            shortcut: command.alternateShortcut,
          },
        ]
      : []),
  ]);
}

/** Renders the shortcut hint interface. */
export function ShortcutHint({
  shortcut,
  className,
}: {
  shortcut: KeyboardShortcut;
  className?: string;
}) {
  const [apple, setApple] = useState(false);

  useEffect(() => setApple(isApplePlatform()), []);

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="sr-only">
        {formatShortcut(shortcut, apple).join(" then ")}
      </span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {formatShortcut(shortcut, apple).map((stroke) => (
          <kbd
            key={stroke}
            className="border-line-strong bg-surface-subtle text-fog inline-flex min-h-5 min-w-5 items-center justify-center rounded-md border px-1.5 font-sans text-[9px] leading-none font-medium shadow-[0_1px_0_var(--app-border-strong)]"
          >
            {stroke}
          </kbd>
        ))}
      </span>
    </span>
  );
}

/** Renders the shortcut alternatives interface. */
export function ShortcutAlternatives({
  shortcut,
  alternateShortcut,
  className,
}: {
  shortcut: KeyboardShortcut;
  alternateShortcut: KeyboardShortcut;
  className?: string;
}) {
  return (
    <span
      className={cn("text-fog inline-flex items-center gap-1.5", className)}
    >
      <ShortcutHint shortcut={shortcut} />
      <span aria-hidden="true" className="text-[9px]">
        /
      </span>
      <ShortcutHint shortcut={alternateShortcut} />
    </span>
  );
}

/** Registers global command-center shortcuts and tracks pending key sequences. */
export function useCommandCenterBindings({
  commands,
  onOpen,
  onOpenShortcuts,
  suspended = false,
}: {
  commands: CommandCenterItem[];
  onOpen: () => void;
  onOpenShortcuts: () => void;
  suspended?: boolean;
}) {
  const [pendingSequence, setPendingSequence] =
    useState<PendingShortcutSequence>();
  const commandsRef = useRef(commands);
  const onOpenRef = useRef(onOpen);
  const onOpenShortcutsRef = useRef(onOpenShortcuts);
  const pendingRef = useRef<
    | {
        bindingIds: string[];
        fallbackBindingId?: string;
        strokeIndex: number;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    commandsRef.current = commands;
    onOpenRef.current = onOpen;
    onOpenShortcutsRef.current = onOpenShortcuts;
  }, [commands, onOpen, onOpenShortcuts]);

  useEffect(() => {
    /** Clears the pending multi-key shortcut sequence. */
    function resetPending() {
      if (pendingRef.current) clearTimeout(pendingRef.current.timeout);
      pendingRef.current = undefined;
      setPendingSequence(undefined);
    }

    /** Routes eligible keyboard events through page and global shortcuts. */
    function onKeyDown(event: KeyboardEvent) {
      if (suspended) {
        resetPending();
        return;
      }
      if (isEditableTarget(event.target)) {
        resetPending();
        return;
      }
      const commandMenuStroke = commandMenuShortcut[0];
      if (
        commandMenuStroke &&
        matchesShortcutStroke(event, commandMenuStroke)
      ) {
        event.preventDefault();
        resetPending();
        onOpenRef.current();
        return;
      }
      if (event.key === "?" && event.shiftKey) {
        event.preventDefault();
        resetPending();
        onOpenShortcutsRef.current();
        return;
      }
      if (pendingRef.current && event.key === "Escape") {
        event.preventDefault();
        resetPending();
        return;
      }

      const bindings = commandBindings(commandsRef.current);

      if (pendingRef.current?.fallbackBindingId && event.key === "Enter") {
        event.preventDefault();
        const fallback = bindings.find(
          ({ bindingId }) =>
            bindingId === pendingRef.current?.fallbackBindingId,
        );
        resetPending();
        if (fallback && !fallback.command.disabled) fallback.command.onSelect();
        return;
      }

      const pending = pendingRef.current;
      const candidates = pending
        ? bindings.filter((binding) =>
            pending.bindingIds.includes(binding.bindingId),
          )
        : bindings;
      const strokeIndex = pending?.strokeIndex ?? 0;
      const matches = candidates.filter(
        (binding) =>
          binding.shortcut[strokeIndex] &&
          matchesShortcutStroke(event, binding.shortcut[strokeIndex]),
      );

      if (matches.length === 0) {
        resetPending();
        return;
      }

      event.preventDefault();
      const completed = matches.find(
        (binding) => binding.shortcut.length === strokeIndex + 1,
      );
      const continuing = matches.filter(
        (binding) => binding.shortcut.length > strokeIndex + 1,
      );
      if (completed && continuing.length === 0) {
        resetPending();
        if (!completed.command.disabled) completed.command.onSelect();
        return;
      }

      resetPending();
      const nextStrokeIndex = strokeIndex + 1;
      setPendingSequence({
        prefix: matches[0]?.shortcut.slice(0, nextStrokeIndex) ?? [],
        fallbackLabel: completed?.command.label,
        options: matches.flatMap((binding) => {
          const stroke = binding.shortcut[nextStrokeIndex];
          return stroke
            ? [
                {
                  label: binding.command.label,
                  stroke,
                  disabled: Boolean(binding.command.disabled),
                },
              ]
            : [];
        }),
      });
      pendingRef.current = {
        bindingIds: matches.map(({ bindingId }) => bindingId),
        fallbackBindingId: completed?.bindingId,
        strokeIndex: nextStrokeIndex,
        timeout: setTimeout(
          () => {
            resetPending();
            if (completed && !completed.command.disabled)
              completed.command.onSelect();
          },
          completed
            ? AMBIGUOUS_SHORTCUT_TIMEOUT_MS
            : SHORTCUT_SEQUENCE_TIMEOUT_MS,
        ),
      };
    }

    /** Clears pending shortcuts when focus enters an editable control. */
    function onFocusIn(event: FocusEvent) {
      if (isEditableTarget(event.target)) resetPending();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current.timeout);
      pendingRef.current = undefined;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [suspended]);

  return pendingSequence;
}

/** Renders the shortcut sequence indicator interface. */
export function ShortcutSequenceIndicator({
  sequence,
}: {
  sequence?: PendingShortcutSequence;
}) {
  if (!sequence) return null;
  const isGoSequence =
    sequence.prefix.length === 1 &&
    sequence.prefix[0]?.key.toLowerCase() === "g";
  const isAiSequence =
    sequence.prefix.length === 1 &&
    sequence.prefix[0]?.key.toLowerCase() === "e";
  const isPullRequestSequence =
    sequence.prefix[0]?.key.toLowerCase() === "g" &&
    sequence.prefix.slice(1).every(({ key }) => /^\d$/.test(key));
  const pullRequestNumber = isPullRequestSequence
    ? sequence.prefix
        .slice(1)
        .map(({ key }) => key)
        .join("")
    : "";
  const numericOptions = sequence.options.filter(({ stroke }) =>
    /^\d$/.test(stroke.key),
  );
  const visibleOptions = [
    ...sequence.options.filter(({ stroke }) => !/^\d$/.test(stroke.key)),
    ...(numericOptions.length > 0
      ? [
          {
            label: pullRequestNumber ? "Add digit" : "Pull request number",
            stroke: { key: "0–9" },
            disabled: numericOptions.every(({ disabled }) => disabled),
          },
        ]
      : []),
  ];

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-20 left-1/2 z-[65] w-[calc(100%-1.5rem)] max-w-fit -translate-x-1/2"
    >
      <div className="bg-panel/96 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-line-strong px-3 py-2.5 shadow-2xl backdrop-blur-xl sm:px-4">
        <span className="text-cloud flex items-center gap-2 text-xs font-medium">
          <ShortcutHint shortcut={sequence.prefix} />
          {pullRequestNumber
            ? `Pull request ${pullRequestNumber}`
            : isGoSequence
              ? "Go to…"
              : isAiSequence
                ? "Ask AI to…"
                : "Continue with…"}
        </span>
        <span className="bg-line-strong hidden h-4 w-px sm:block" />
        <span className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
          {visibleOptions.map((option) => (
            <span
              key={`${option.stroke.key}-${option.label}`}
              className={cn(
                "text-mist flex items-center gap-1.5 whitespace-nowrap text-[10px]",
                option.disabled && "opacity-45",
              )}
            >
              <ShortcutHint shortcut={[option.stroke]} />
              {option.label.replace(/^Go to /, "")}
            </span>
          ))}
          {sequence.fallbackLabel && (
            <span className="text-mist flex items-center gap-1.5 whitespace-nowrap text-[10px]">
              <ShortcutHint shortcut={[{ key: "Enter" }]} />
              Open now
            </span>
          )}
        </span>
        <span className="text-fog hidden text-[9px] lg:inline">
          Esc cancels
        </span>
      </div>
    </div>
  );
}

/** Renders the searchable command and keyboard-shortcut palette. */
export function CommandCenter({
  commands,
  mode,
  onClose,
}: {
  commands: CommandCenterItem[];
  mode?: CommandCenterMode;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const componentId = useId().replaceAll(":", "");
  const titleId = `${componentId}-title`;
  const listboxId = `${componentId}-listbox`;
  const visibleCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return commands.filter((command) => {
      if (
        mode === "shortcuts" &&
        !command.shortcut &&
        !command.alternateShortcut
      )
        return false;
      if (!normalized) return !command.searchOnly;
      return [
        command.label,
        command.description,
        command.group,
        ...(command.keywords ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
  }, [commands, mode, query]);
  const groups = useMemo(
    () =>
      Array.from(new Set(visibleCommands.map((command) => command.group))).map(
        (group) => ({
          group,
          commands: visibleCommands.filter(
            (command) => command.group === group,
          ),
        }),
      ),
    [visibleCommands],
  );

  useEffect(() => {
    if (!mode) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setQuery("");
    setSelectedIndex(0);
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [mode]);

  useEffect(() => {
    const selected = visibleCommands[selectedIndex];
    if (selected && !selected.disabled) return;
    const firstEnabled = visibleCommands.findIndex(({ disabled }) => !disabled);
    setSelectedIndex(Math.max(0, firstEnabled));
  }, [selectedIndex, visibleCommands]);

  if (!mode) return null;

  /** Closes the palette and executes an enabled command. */
  function run(command: CommandCenterItem) {
    if (command.disabled) return;
    onClose();
    command.onSelect();
  }

  /** Selects the next enabled option without moving beyond the list boundary. */
  function moveSelection(direction: -1 | 1) {
    for (
      let index = selectedIndex + direction;
      index >= 0 && index < visibleCommands.length;
      index += direction
    ) {
      if (!visibleCommands[index]?.disabled) {
        setSelectedIndex(index);
        return;
      }
    }
  }

  const activeOptionId = visibleCommands[selectedIndex]
    ? `${listboxId}-option-${selectedIndex}`
    : undefined;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === "Escape") {
          onClose();
        }
      }}
      className={cn(
        modalSurfaceClassName,
        "z-[70] justify-center bg-black/65 px-3 pt-[10dvh] backdrop:bg-black/65 backdrop:backdrop-blur-sm sm:px-6 sm:pt-[14dvh]",
      )}
    >
      <section className="bg-panel relative flex max-h-[72dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-4">
          <Search className="text-fog size-4 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const command = visibleCommands[selectedIndex];
                if (command) run(command);
              }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={activeOptionId}
            aria-label={
              mode === "commands"
                ? "Search commands"
                : "Search keyboard shortcuts"
            }
            placeholder={
              mode === "commands"
                ? "Search actions and destinations"
                : "Find a keyboard shortcut"
            }
            className="text-cloud placeholder:text-fog h-14 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close command center"
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
          >
            <X className="size-4" />
          </button>
        </header>
        <h2 id={titleId} className="sr-only">
          {mode === "commands" ? "Quick actions" : "Keyboard shortcuts"}
        </h2>
        <div
          id={listboxId}
          role="listbox"
          aria-label={
            mode === "commands" ? "Available actions" : "Available shortcuts"
          }
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {visibleCommands.length === 0 ? (
            <div role="presentation">
              <p className="text-mist px-4 py-12 text-center text-sm">
                No matching actions.
              </p>
            </div>
          ) : (
            groups.map(({ group, commands: groupCommands }) => (
              <fieldset
                key={group}
                className="m-0 mb-2 min-w-0 border-0 p-0 last:mb-0"
              >
                <legend className="text-fog block w-full px-3 py-2 text-[9px] font-semibold tracking-[.14em] uppercase">
                  {group}
                </legend>
                {groupCommands.map((command) => {
                  const index = visibleCommands.indexOf(command);
                  const selected = index === selectedIndex;
                  return (
                    <button
                      key={command.id}
                      id={`${listboxId}-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={command.disabled}
                      onMouseMove={() => setSelectedIndex(index)}
                      onClick={() => run(command)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition",
                        selected && "bg-surface-hover",
                        command.disabled && "cursor-not-allowed opacity-45",
                      )}
                    >
                      {command.icon && (
                        <span className="text-cyan bg-cyan/[.07] grid size-8 shrink-0 place-items-center rounded-lg">
                          {command.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="text-cloud block truncate text-xs font-medium">
                          {command.label}
                        </span>
                        {command.description && (
                          <span className="text-fog mt-0.5 block truncate text-[10px]">
                            {command.description}
                          </span>
                        )}
                      </span>
                      {command.shortcut && command.alternateShortcut ? (
                        <ShortcutAlternatives
                          shortcut={command.shortcut}
                          alternateShortcut={command.alternateShortcut}
                          className="shrink-0"
                        />
                      ) : command.shortcut ? (
                        <ShortcutHint
                          shortcut={command.shortcut}
                          className="shrink-0"
                        />
                      ) : command.alternateShortcut ? (
                        <ShortcutHint
                          shortcut={command.alternateShortcut}
                          className="shrink-0"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </fieldset>
            ))
          )}
        </div>
        <footer className="text-fog flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 text-[9px]">
          <span className="flex items-center gap-1.5">
            <ShortcutHint
              shortcut={[{ key: "ArrowUp" }, { key: "ArrowDown" }]}
            />
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <ShortcutHint shortcut={[{ key: "Enter" }]} />
            Run
          </span>
          <span className="flex items-center gap-1.5">
            <ShortcutHint shortcut={[{ key: "Escape" }]} />
            Close
          </span>
          {mode === "commands" && (
            <span className="ml-auto hidden items-center gap-1.5 sm:flex">
              <ShortcutHint shortcut={shortcutHelpShortcut} />
              All shortcuts
            </span>
          )}
        </footer>
      </section>
    </dialog>
  );
}
