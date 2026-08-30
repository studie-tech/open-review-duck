// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CommandCenterItem,
  PendingShortcutSequence,
} from "./command-center";
import {
  PageCommandCenterProvider,
  usePageCommandCenter,
  useRegisterPageCommands,
} from "./page-command-center";

const goPrefix: PendingShortcutSequence = {
  prefix: [{ key: "g" }],
  options: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Registers a command array without reading the pending shortcut. */
function RegisterOnlyPage({ onRender }: { onRender: () => void }) {
  onRender();
  const commands = useMemo<CommandCenterItem[]>(() => [], []);
  useRegisterPageCommands(commands);

  return <span>register only</span>;
}

/** Renders the pending shortcut prefix so the test can observe it. */
function ShortcutAwarePage() {
  const commands = useMemo<CommandCenterItem[]>(() => [], []);
  const pendingShortcut = usePageCommandCenter(commands);

  return <span>{`prefix: ${pendingShortcut?.prefix[0]?.key ?? "none"}`}</span>;
}

describe("PageCommandCenterProvider", () => {
  it("keeps register-only pages out of pending shortcut updates", () => {
    const onRender = vi.fn();
    const register = vi.fn(() => () => {});
    /** Mirrors the shell, whose page children survive its own re-renders. */
    function ShellHarness({ children }: { children: ReactNode }) {
      const [pendingShortcut, setPendingShortcut] =
        useState<PendingShortcutSequence>();

      return (
        <>
          <button type="button" onClick={() => setPendingShortcut(goPrefix)}>
            press g
          </button>
          <PageCommandCenterProvider
            pendingShortcut={pendingShortcut}
            register={register}
          >
            {children}
          </PageCommandCenterProvider>
        </>
      );
    }

    render(
      <ShellHarness>
        <RegisterOnlyPage onRender={onRender} />
        <ShortcutAwarePage />
      </ShellHarness>,
    );
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(screen.getByText("prefix: none")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "press g" }));

    expect(screen.getByText("prefix: g")).toBeInTheDocument();
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(2);
  });
});
