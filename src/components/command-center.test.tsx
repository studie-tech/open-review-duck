// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandCenter,
  type CommandCenterItem,
  type CommandCenterMode,
  ShortcutSequenceIndicator,
  useCommandCenterBindings,
} from "./command-center";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Renders the command center harness interface. */
function CommandCenterHarness({
  onNavigate,
  suspended = false,
}: {
  onNavigate: () => void;
  suspended?: boolean;
}) {
  const [mode, setMode] = useState<CommandCenterMode>();
  const commands: CommandCenterItem[] = [
    {
      id: "reviews",
      label: "Go to pull requests",
      group: "Navigate",
      shortcut: [{ key: "g" }, { key: "r" }],
      onSelect: onNavigate,
    },
    {
      id: "hidden-until-search",
      label: "Open utility function",
      group: "Review units",
      searchOnly: true,
      onSelect: vi.fn(),
    },
  ];
  const pendingShortcut = useCommandCenterBindings({
    commands,
    onOpen: () => setMode("commands"),
    onOpenShortcuts: () => setMode("shortcuts"),
    suspended,
  });

  return (
    <>
      <input aria-label="Comment editor" />
      <CommandCenter
        commands={commands}
        mode={mode}
        onClose={() => setMode(undefined)}
      />
      <ShortcutSequenceIndicator sequence={pendingShortcut} />
    </>
  );
}

/** Renders the numeric shortcut harness interface. */
function NumericShortcutHarness({
  onFirst,
  onTwelfth,
}: {
  onFirst: () => void;
  onTwelfth: () => void;
}) {
  const commands: CommandCenterItem[] = [
    {
      id: "pr-1",
      label: "Open pull request 1",
      group: "Pull requests",
      shortcut: [{ key: "g" }, { key: "1" }],
      onSelect: onFirst,
    },
    {
      id: "pr-12",
      label: "Open pull request 12",
      group: "Pull requests",
      shortcut: [{ key: "g" }, { key: "1" }, { key: "2" }],
      onSelect: onTwelfth,
    },
  ];
  const pendingShortcut = useCommandCenterBindings({
    commands,
    onOpen: vi.fn(),
    onOpenShortcuts: vi.fn(),
  });

  return <ShortcutSequenceIndicator sequence={pendingShortcut} />;
}

/** Renders the alternate shortcut harness interface. */
function AlternateShortcutHarness({
  onNext,
  onScroll,
}: {
  onNext: () => void;
  onScroll: () => void;
}) {
  const commands: CommandCenterItem[] = [
    {
      id: "next-unit",
      label: "Open next unit",
      group: "Review navigation",
      shortcut: [{ key: "j" }],
      alternateShortcut: [{ key: "ArrowRight" }],
      onSelect: onNext,
    },
    {
      id: "scroll-code-down",
      label: "Scroll code down",
      group: "Review navigation",
      shortcut: [{ key: "ArrowDown" }],
      alternateShortcut: [{ key: "g" }, { key: "d" }],
      onSelect: onScroll,
    },
  ];
  useCommandCenterBindings({
    commands,
    onOpen: vi.fn(),
    onOpenShortcuts: vi.fn(),
  });

  return <input aria-label="Review note" />;
}

/** Renders a single-key review-action shortcut harness. */
function ReviewActionShortcutHarness({ onLoad }: { onLoad: () => void }) {
  useCommandCenterBindings({
    commands: [
      {
        id: "load-changes",
        label: "Load code changes",
        group: "Review actions",
        shortcut: [{ key: "r" }],
        onSelect: onLoad,
      },
    ],
    onOpen: vi.fn(),
    onOpenShortcuts: vi.fn(),
  });

  return <input aria-label="Review feedback" />;
}

/** Renders related sync and guarded reset shortcuts. */
function SyncAndResetShortcutHarness({
  onReset,
  onSync,
}: {
  onReset: () => void;
  onSync: () => void;
}) {
  useCommandCenterBindings({
    commands: [
      {
        id: "sync",
        label: "Sync",
        group: "Review actions",
        shortcut: [{ key: "r" }],
        onSelect: onSync,
      },
      {
        id: "reset",
        label: "Reset review",
        group: "Review actions",
        shortcut: [{ key: "r", shift: true }],
        onSelect: onReset,
      },
    ],
    onOpen: vi.fn(),
    onOpenShortcuts: vi.fn(),
  });

  return null;
}

/** Renders independent left and right review-panel shortcuts. */
function ReviewPanelShortcutHarness({
  onToggleInsights,
  onTogglePath,
}: {
  onToggleInsights: () => void;
  onTogglePath: () => void;
}) {
  useCommandCenterBindings({
    commands: [
      {
        id: "toggle-path",
        label: "Toggle review path",
        group: "Review navigation",
        shortcut: [{ key: "b", mod: true }],
        onSelect: onTogglePath,
      },
      {
        id: "toggle-insights",
        label: "Toggle AI assistance",
        group: "Review navigation",
        shortcut: [{ key: "g", mod: true }],
        onSelect: onToggleInsights,
      },
    ],
    onOpen: vi.fn(),
    onOpenShortcuts: vi.fn(),
  });

  return <input aria-label="Inline comment" />;
}

/** Renders direct sync and AI action shortcuts. */
function AiActionShortcutHarness({
  onAsk,
  onReview,
  onSync,
}: {
  onAsk: () => void;
  onReview: () => void;
  onSync: () => void;
}) {
  const pendingShortcut = useCommandCenterBindings({
    commands: [
      {
        id: "sync",
        label: "Sync GitHub",
        group: "Review actions",
        shortcut: [{ key: "r" }],
        onSelect: onSync,
      },
      {
        id: "ask",
        label: "Ask AI about this code",
        group: "Review actions",
        shortcut: [{ key: "e" }],
        onSelect: onAsk,
      },
      {
        id: "review",
        label: "Review the full pull request",
        group: "Review actions",
        shortcut: [{ key: "a" }],
        onSelect: onReview,
      },
    ],
    onOpen: vi.fn(),
    onOpenShortcuts: vi.fn(),
  });

  return <ShortcutSequenceIndicator sequence={pendingShortcut} />;
}

describe("CommandCenter", () => {
  it("opens with Q and runs the selected command", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<CommandCenterHarness onNavigate={onNavigate} />);

    fireEvent.keyDown(document, { key: "q" });

    expect(
      screen.getByRole("dialog", { name: "Quick actions" }),
    ).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("opens keyboard shortcuts with the browser-safe help binding", () => {
    render(<CommandCenterHarness onNavigate={vi.fn()} />);

    fireEvent.keyDown(document, { key: "?", shiftKey: true });
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
  });

  it("supports navigation sequences but suppresses them while typing", () => {
    const onNavigate = vi.fn();
    render(<CommandCenterHarness onNavigate={onNavigate} />);

    fireEvent.keyDown(document, { key: "g" });
    expect(screen.getByRole("status")).toHaveTextContent("Go to…");
    expect(screen.getByRole("status")).toHaveTextContent("pull requests");
    fireEvent.keyDown(document, { key: "r" });
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const editor = screen.getByRole("textbox", { name: "Comment editor" });
    fireEvent.keyDown(editor, { key: "q" });
    fireEvent.keyDown(editor, { key: "g" });
    fireEvent.keyDown(editor, { key: "r" });
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("distinguishes sync from the guarded reset shortcut", () => {
    const onReset = vi.fn();
    const onSync = vi.fn();
    render(<SyncAndResetShortcutHarness onReset={onReset} onSync={onSync} />);

    fireEvent.keyDown(document, { key: "r" });
    expect(onSync).toHaveBeenCalledOnce();
    expect(onReset).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "R", shiftKey: true });
    expect(onReset).toHaveBeenCalledOnce();
    expect(onSync).toHaveBeenCalledOnce();
  });

  it("toggles each review panel independently without firing while typing", () => {
    const onToggleInsights = vi.fn();
    const onTogglePath = vi.fn();
    render(
      <ReviewPanelShortcutHarness
        onToggleInsights={onToggleInsights}
        onTogglePath={onTogglePath}
      />,
    );

    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(onTogglePath).toHaveBeenCalledOnce();
    expect(onToggleInsights).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "g", ctrlKey: true });
    expect(onToggleInsights).toHaveBeenCalledOnce();

    const comment = screen.getByRole("textbox", { name: "Inline comment" });
    fireEvent.keyDown(comment, { key: "b", ctrlKey: true });
    fireEvent.keyDown(comment, { key: "g", ctrlKey: true });
    expect(onTogglePath).toHaveBeenCalledOnce();
    expect(onToggleInsights).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "[" });
    fireEvent.keyDown(document, { key: "]" });
    expect(onTogglePath).toHaveBeenCalledOnce();
    expect(onToggleInsights).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "n", ctrlKey: true });
    expect(onTogglePath).toHaveBeenCalledOnce();
    expect(onToggleInsights).toHaveBeenCalledOnce();
  });

  it("waits for additional digits when a pull request position is ambiguous", () => {
    const onFirst = vi.fn();
    const onTwelfth = vi.fn();
    render(<NumericShortcutHarness onFirst={onFirst} onTwelfth={onTwelfth} />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "1" });

    expect(onFirst).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Pull request 1");
    expect(screen.getByRole("status")).toHaveTextContent("Open now");

    fireEvent.keyDown(document, { key: "2" });
    expect(onTwelfth).toHaveBeenCalledOnce();
    expect(onFirst).not.toHaveBeenCalled();
  });

  it("opens an ambiguous single-digit position immediately with Enter", () => {
    const onFirst = vi.fn();
    render(<NumericShortcutHarness onFirst={onFirst} onTwelfth={vi.fn()} />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "1" });
    fireEvent.keyDown(document, { key: "Enter" });

    expect(onFirst).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens an ambiguous single-digit position after a brief pause", () => {
    vi.useFakeTimers();
    const onFirst = vi.fn();
    render(<NumericShortcutHarness onFirst={onFirst} onTwelfth={vi.fn()} />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "1" });
    act(() => vi.advanceTimersByTime(850));

    expect(onFirst).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("cancels a pending sequence with Escape", () => {
    render(<CommandCenterHarness onNavigate={vi.fn()} />);

    fireEvent.keyDown(document, { key: "g" });
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("suspends global commands during a focused keyboard interaction", () => {
    render(<CommandCenterHarness onNavigate={vi.fn()} suspended />);

    fireEvent.keyDown(document, { key: "q" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("supports alternate shortcuts and suppresses them while typing", () => {
    const onNext = vi.fn();
    const onScroll = vi.fn();
    render(<AlternateShortcutHarness onNext={onNext} onScroll={onScroll} />);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onNext).toHaveBeenCalledOnce();
    expect(onScroll).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "d" });
    expect(onScroll).toHaveBeenCalledTimes(2);

    const note = screen.getByRole("textbox", { name: "Review note" });
    fireEvent.keyDown(note, { key: "ArrowRight" });
    fireEvent.keyDown(note, { key: "ArrowDown" });
    expect(onNext).toHaveBeenCalledOnce();
    expect(onScroll).toHaveBeenCalledTimes(2);
  });

  it("runs a single-key review action without intercepting typed text", () => {
    const onLoad = vi.fn();
    render(<ReviewActionShortcutHarness onLoad={onLoad} />);

    fireEvent.keyDown(document, { key: "r" });
    expect(onLoad).toHaveBeenCalledOnce();

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Review feedback" }),
      {
        key: "r",
      },
    );
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("routes direct AI shortcuts without entering a prefix sequence", () => {
    const onAsk = vi.fn();
    const onReview = vi.fn();
    const onSync = vi.fn();
    render(
      <AiActionShortcutHarness
        onAsk={onAsk}
        onReview={onReview}
        onSync={onSync}
      />,
    );

    fireEvent.keyDown(document, { key: "e" });
    expect(onAsk).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "a" });

    expect(onReview).toHaveBeenCalledOnce();
    expect(onSync).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "r" });
    expect(onSync).toHaveBeenCalledOnce();
  });

  it("keeps large switcher lists hidden until the user searches", async () => {
    const user = userEvent.setup();
    render(<CommandCenterHarness onNavigate={vi.fn()} />);
    fireEvent.keyDown(document, { key: "q" });

    expect(
      screen.queryByRole("button", { name: /Open utility function/ }),
    ).not.toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "Search commands" }),
      "utility",
    );
    expect(
      screen.getByRole("button", { name: /Open utility function/ }),
    ).toBeInTheDocument();
  });
});
