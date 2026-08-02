"use client";

import { createContext, type ReactNode, useContext, useEffect } from "react";

import type {
  CommandCenterItem,
  PendingShortcutSequence,
} from "~/components/command-center";

type PageCommandCenterValue = {
  pendingShortcut?: PendingShortcutSequence;
  register: (commands: CommandCenterItem[]) => () => void;
};

const PageCommandCenterContext = createContext<
  PageCommandCenterValue | undefined
>(undefined);

/** Provides page-specific commands and pending shortcut state to descendants. */
export function PageCommandCenterProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: PageCommandCenterValue;
}) {
  return (
    <PageCommandCenterContext value={value}>
      {children}
    </PageCommandCenterContext>
  );
}

/** Registers page-specific commands for the lifetime of the calling component. */
export function usePageCommandCenter(commands: CommandCenterItem[]) {
  const context = useContext(PageCommandCenterContext);

  useEffect(() => context?.register(commands), [commands, context?.register]);

  return context?.pendingShortcut;
}
