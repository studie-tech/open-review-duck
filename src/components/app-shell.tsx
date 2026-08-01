"use client";

import { UserButton } from "@clerk/nextjs";
import {
  ArrowRight,
  Bot,
  Flame,
  LayoutDashboard,
  PlugZap,
  Search,
  Settings,
  Sparkles,
  Trophy,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { BrandMark } from "~/components/brand-mark";
import {
  CommandCenter,
  type CommandCenterItem,
  type CommandCenterMode,
  ShortcutHint,
  ShortcutSequenceIndicator,
  useCommandCenterBindings,
} from "~/components/command-center";
import { PageCommandCenterProvider } from "~/components/page-command-center";
import { ThemeToggle } from "~/components/theme-toggle";
import type { DeploymentMode } from "~/lib/deployment";
import {
  commandMenuShortcut,
  type KeyboardShortcut,
} from "~/lib/keyboard-shortcuts";
import { sidebarGuidance } from "~/lib/sidebar-guidance";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

const navigation = [
  {
    href: "/dashboard",
    label: "Pull requests",
    mobileLabel: "Reviews",
    icon: LayoutDashboard,
    shortcut: [{ key: "g" }, { key: "r" }],
  },
  {
    href: "/dashboard/achievements",
    label: "Achievements",
    mobileLabel: "Progress",
    icon: Trophy,
    shortcut: [{ key: "g" }, { key: "p" }],
  },
  {
    href: "/settings/ai",
    label: "AI assistant",
    mobileLabel: "AI",
    icon: Sparkles,
    shortcut: [{ key: "g" }, { key: "a" }],
  },
  {
    href: "/settings",
    label: "Settings",
    mobileLabel: "Settings",
    icon: Settings,
    shortcut: [{ key: "g" }, { key: "s" }],
  },
] satisfies Array<{
  href: string;
  label: string;
  mobileLabel: string;
  icon: typeof LayoutDashboard;
  shortcut: KeyboardShortcut;
}>;

/** Checks whether a navigation item matches the current route. */
function isNavigationActive(pathname: string, href: string) {
  if (href === "/dashboard") {
    return pathname === href;
  }
  if (href === "/settings") {
    return pathname === href || pathname.startsWith("/settings/providers");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

type Guidance = RouterOutputs["workspace"]["guidance"];
const INBOX_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

/** Renders the app shell interface. */
export function AppShell({
  children,
  deploymentMode,
  initialGuidance,
}: {
  children: ReactNode;
  deploymentMode: DeploymentMode;
  initialGuidance: Guidance;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const utils = api.useUtils();
  const reconcileIntake = api.provider.reconcileWorkspaceIntake.useMutation({
    onSuccess: (result) => {
      if (result.queued === 0 && result.stateChanges === 0) return;
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
        utils.provider.listImportedRepositories.invalidate(),
        utils.provider.listOpenPullRequests.invalidate(),
      ]);
    },
  });
  const reconcileIntakeRef = useRef(reconcileIntake);
  reconcileIntakeRef.current = reconcileIntake;
  useEffect(() => {
    /** Refreshes provider state without overlapping an existing reconciliation. */
    const reconcile = () => {
      if (!reconcileIntakeRef.current.isPending) {
        reconcileIntakeRef.current.mutate();
      }
    };
    reconcile();
    window.addEventListener("focus", reconcile);
    const interval = window.setInterval(
      reconcile,
      INBOX_RECONCILIATION_INTERVAL_MS,
    );
    return () => {
      window.removeEventListener("focus", reconcile);
      window.clearInterval(interval);
    };
  }, []);
  const guidanceQuery = api.workspace.guidance.useQuery(undefined, {
    initialData: initialGuidance,
  });
  const guidance = sidebarGuidance(guidanceQuery.data);
  const GuidanceIcon =
    guidance?.kind === "provider"
      ? PlugZap
      : guidance?.kind === "ai"
        ? Sparkles
        : Flame;
  const [commandCenterMode, setCommandCenterMode] =
    useState<CommandCenterMode>();
  const [pageCommands, setPageCommands] = useState<CommandCenterItem[]>([]);
  const openCommands = useCallback(() => setCommandCenterMode("commands"), []);
  const openShortcuts = useCallback(
    () => setCommandCenterMode("shortcuts"),
    [],
  );
  const registerPageCommands = useCallback((next: CommandCenterItem[]) => {
    setPageCommands(next);
    return () =>
      setPageCommands((current) => (current === next ? [] : current));
  }, []);
  const commands = useMemo<CommandCenterItem[]>(
    () => [
      ...navigation.map(({ href, label, icon: Icon, shortcut }) => ({
        id: `navigate-${href}`,
        label: `Go to ${label}`,
        description: href === pathname ? "You are here" : undefined,
        group: "Navigate",
        icon: <Icon className="size-4" />,
        shortcut,
        disabled: href === pathname,
        onSelect: () => router.push(href),
      })),
      {
        id: "navigate-providers",
        label: "Manage code providers",
        description: "Connect repositories and provider accounts",
        group: "Workspace",
        icon: <PlugZap className="size-4" />,
        shortcut: [{ key: "g" }, { key: "c" }],
        onSelect: () => router.push("/settings/providers"),
      },
      {
        id: "navigate-ai",
        label: "Configure AI models",
        description: "Manage assistance, providers, and model options",
        group: "Workspace",
        icon: <Bot className="size-4" />,
        onSelect: () => router.push("/settings/ai"),
      },
      ...pageCommands,
    ],
    [pageCommands, pathname, router],
  );
  const pendingShortcut = useCommandCenterBindings({
    commands,
    onOpen: openCommands,
    onOpenShortcuts: openShortcuts,
  });
  const showNavigationShortcuts =
    pendingShortcut?.prefix.length === 1 &&
    pendingShortcut.prefix[0]?.key.toLowerCase() === "g";

  return (
    <div className="bg-ink min-h-screen">
      <aside className="bg-panel fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line p-5 lg:block">
        <Link href="/dashboard" className="flex items-center gap-3 px-2">
          <BrandMark className="size-10" />
          <span className="font-semibold tracking-tight">ReviewDuck.ai</span>
        </Link>
        <nav className="mt-10 space-y-1">
          {navigation.map(({ href, label, icon: Icon, shortcut }) => {
            const active = isNavigationActive(pathname, href);

            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
                  active
                    ? "bg-surface-hover text-cloud"
                    : "text-mist hover:bg-surface-subtle hover:text-cloud",
                )}
              >
                <Icon
                  className={cn("size-4", active && "text-lime")}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <ShortcutHint
                  shortcut={shortcut}
                  className={cn(
                    "transition",
                    showNavigationShortcuts
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100",
                  )}
                />
              </Link>
            );
          })}
        </nav>
        {guidance && (
          <Link
            href={guidance.href}
            aria-label={`${guidance.action}: ${guidance.title}`}
            className="border-lime/20 bg-lime/[.055] hover:border-lime/35 hover:bg-lime/[.085] group absolute inset-x-5 bottom-5 rounded-2xl border p-4 transition"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="bg-lime/10 text-lime grid size-8 shrink-0 place-items-center rounded-lg">
                <GuidanceIcon className="size-4" aria-hidden="true" />
              </span>
              <span className="text-lime pt-1 text-[10px] font-semibold tracking-[.1em] uppercase">
                {guidance.eyebrow}
              </span>
            </div>
            <p className="mt-4 text-lg font-semibold leading-6">
              {guidance.title}
            </p>
            <p className="text-mist mt-1.5 text-xs leading-5">
              {guidance.description}
            </p>
            <span className="text-lime mt-3 flex items-center gap-1.5 text-xs font-semibold">
              {guidance.action}
              <ArrowRight
                className="size-3.5 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </span>
          </Link>
        )}
      </aside>
      <div className="lg:pl-64">
        <header className="bg-ink/88 sticky top-0 z-10 flex h-16 items-center justify-between border-b border-line px-5 backdrop-blur-xl sm:px-8">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 font-semibold lg:hidden"
          >
            <BrandMark className="size-9" />
            ReviewDuck.ai
          </Link>
          <div className="text-fog hidden text-xs lg:block">
            {deploymentMode === "local"
              ? "Local review workspace"
              : "Focused review workspace"}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={openCommands}
              aria-label="Open quick actions"
              className="text-mist hover:text-cloud flex h-9 items-center gap-2 rounded-lg border border-line bg-surface/65 px-2.5 text-xs transition hover:bg-surface-hover sm:px-3"
            >
              <Search className="size-3.5" />
              <span className="hidden sm:inline">Quick actions</span>
              <ShortcutHint
                shortcut={commandMenuShortcut}
                className="hidden sm:inline-flex"
              />
            </button>
            <ThemeToggle />
            {deploymentMode === "saas" && <UserButton />}
          </div>
        </header>
        <nav className="bg-panel grid grid-cols-4 gap-1 border-b border-line px-4 py-2 lg:hidden">
          {navigation.map(({ href, label, mobileLabel, icon: Icon }) => {
            const active = isNavigationActive(pathname, href);

            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-1 py-2 text-xs transition sm:gap-2 sm:px-3",
                  active
                    ? "bg-surface-hover text-cloud"
                    : "text-mist hover:text-cloud",
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate sm:hidden">{mobileLabel}</span>
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>
        <PageCommandCenterProvider
          value={{
            pendingShortcut,
            register: registerPageCommands,
          }}
        >
          {children}
        </PageCommandCenterProvider>
        <footer className="text-fog flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-line px-5 py-6 text-[11px]">
          <span>© 2026 ReviewDuck</span>
          <a
            href="https://github.com/studie-tech/open-review-duck"
            target="_blank"
            rel="noreferrer"
            className="hover:text-cloud transition"
          >
            Source
          </a>
          <a
            href="https://github.com/studie-tech/open-review-duck/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
            className="hover:text-cloud transition"
          >
            AGPL-3.0
          </a>
          <span>No warranty</span>
        </footer>
      </div>
      <CommandCenter
        commands={commands}
        mode={commandCenterMode}
        onClose={() => setCommandCenterMode(undefined)}
      />
      <ShortcutSequenceIndicator sequence={pendingShortcut} />
    </div>
  );
}
