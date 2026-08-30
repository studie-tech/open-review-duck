"use client";

import { createContext, type ReactNode, useContext, useEffect } from "react";

import type {
  CommandCenterItem,
  PendingShortcutSequence,
} from "~/components/command-center";

type RegisterPageCommands = (commands: CommandCenterItem[]) => () => void;

// Registration and the pending shortcut sequence live in separate contexts so
// that pages which only contribute commands are not re-rendered every time a
// shortcut prefix changes or the shell re-renders for its own reasons.
const RegisterPageCommandsContext = createContext<
  RegisterPageCommands | undefined
>(undefined);

const PendingShortcutContext = createContext<
  PendingShortcutSequence | undefined
>(undefined);

/** Provides page-specific commands and pending shortcut state to descendants. */
export function PageCommandCenterProvider({
  children,
  pendingShortcut,
  register,
}: {
  children: ReactNode;
  pendingShortcut?: PendingShortcutSequence;
  register: RegisterPageCommands;
}) {
  return (
    <RegisterPageCommandsContext value={register}>
      <PendingShortcutContext value={pendingShortcut}>
        {children}
      </PendingShortcutContext>
    </RegisterPageCommandsContext>
  );
}

/** Registers page-specific commands for the lifetime of the calling component. */
export function useRegisterPageCommands(commands: CommandCenterItem[]) {
  const register = useContext(RegisterPageCommandsContext);

  useEffect(() => register?.(commands), [commands, register]);
}

/** Registers page commands and reports the shortcut sequence being typed. */
export function usePageCommandCenter(commands: CommandCenterItem[]) {
  useRegisterPageCommands(commands);

  return useContext(PendingShortcutContext);
}
