// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoReviewsContent } from "./repo-reviews-content";

type Rule = {
  id: string;
  monitorId: string;
  title: string;
  instruction: string;
  pathGlob: string;
  scope: string;
  severity: string;
  enabled: boolean;
  version: number;
};

type UpdateInput = {
  monitorId: string;
  ruleId: string;
  enabled?: boolean;
  title?: string;
};

const ruleCache = vi.hoisted(() => ({
  rules: [] as Rule[],
  listeners: new Set<() => void>(),
  invalidate: vi.fn(),
  updateOptions: undefined as
    | {
        onMutate?: (input: UpdateInput) => void;
        onSuccess?: (result: unknown, input: UpdateInput) => void;
      }
    | undefined,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("~/trpc/react", async () => {
  const { useSyncExternalStore } = await import("react");
  /** Subscribes a component to the fake rules cache. */
  const useRules = () =>
    useSyncExternalStore(
      (listener) => {
        ruleCache.listeners.add(listener);
        return () => {
          ruleCache.listeners.delete(listener);
        };
      },
      () => ruleCache.rules,
      () => ruleCache.rules,
    );
  /** Replays the tRPC cache writer the component uses for optimistic edits. */
  const setRules = (
    _input: { monitorId: string },
    updater: (current: Rule[]) => Rule[] | undefined,
  ) => {
    ruleCache.rules = updater(ruleCache.rules) ?? ruleCache.rules;
    for (const listener of ruleCache.listeners) listener();
  };
  /** Stands in for a mutation that never resolves on its own. */
  const idleMutation = () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  });
  /** Reports an empty list for the reads the rules section does not use. */
  const emptyQuery = () => ({ data: [], isLoading: false });
  return {
    api: {
      useUtils: () => ({
        repoReviews: {
          list: { invalidate: vi.fn(), setData: vi.fn() },
          history: { invalidate: vi.fn(), setData: vi.fn() },
          findings: { invalidate: vi.fn() },
          rules: { invalidate: ruleCache.invalidate, setData: setRules },
        },
      }),
      provider: {
        listImportedRepositories: {
          useQuery: (
            _input: undefined,
            options: { initialData: unknown[] },
          ) => ({ data: options.initialData }),
        },
      },
      repoReviews: {
        list: {
          useQuery: (
            _input: undefined,
            options: { initialData: unknown[] },
          ) => ({ data: options.initialData }),
        },
        runProgress: { useQuery: () => ({ data: undefined }) },
        history: { useQuery: emptyQuery },
        findings: { useQuery: emptyQuery },
        listBranches: { useQuery: emptyQuery },
        rules: { useQuery: () => ({ data: useRules(), isLoading: false }) },
        sync: { useMutation: idleMutation },
        remove: { useMutation: idleMutation },
        add: { useMutation: idleMutation },
        startRun: { useMutation: idleMutation },
        addRule: { useMutation: idleMutation },
        archiveRule: { useMutation: idleMutation },
        deleteReport: { useMutation: idleMutation },
        updateRule: {
          useMutation: (
            options: NonNullable<typeof ruleCache.updateOptions>,
          ) => {
            ruleCache.updateOptions = options;
            return {
              isPending: false,
              mutate: (input: UpdateInput) => options.onMutate?.(input),
            };
          },
        },
      },
    },
  };
});

/** Builds one compliance rule for the fake cache. */
function buildRule(overrides: Partial<Rule> & { id: string }): Rule {
  return {
    monitorId: "monitor-1",
    title: "Utilities below routers",
    instruction: "Keep helpers out of routers.",
    pathGlob: "**/*",
    scope: "file",
    severity: "medium",
    enabled: true,
    version: 1,
    ...overrides,
  };
}

const monitor = {
  id: "monitor-1",
  branch: "main",
  currentHeadSha: "abc1234def",
  lastCheckedAt: new Date("2026-08-30T10:00:00Z"),
  lastSyncedAt: new Date("2026-08-30T10:00:00Z"),
  lastError: null,
  createdAt: new Date("2026-08-01T10:00:00Z"),
  pullRequestId: "pull-request-1",
  repositoryId: "repository-1",
  repositoryOwner: "reviewduck",
  repositoryName: "app",
  repositoryWebUrl: "https://example.test/reviewduck/app",
  provider: "github",
  snapshot: {
    id: "snapshot-1",
    version: 1,
    headSha: "abc1234def",
    createdAt: new Date("2026-08-30T10:00:00Z"),
  },
  progress: { total: 2, signed: 1, unseen: 1, changed: 0 },
  coverage: { files: 3, reviewableFiles: 2, nonReviewableFiles: 1 },
  activeSync: null,
  latestCodeRun: null,
  latestComplianceRun: null,
};

type ContentProps = ComponentProps<typeof RepoReviewsContent>;

/** Renders the cockpit with the rules section open. */
async function renderRulesSection() {
  const user = userEvent.setup();
  render(
    <RepoReviewsContent
      initialMonitors={[monitor] as unknown as ContentProps["initialMonitors"]}
      initialRepositories={[] as ContentProps["initialRepositories"]}
      fetchedAt={Date.now()}
    />,
  );
  const sections = screen.getByRole("navigation", {
    name: "Repository review sections",
  });
  await user.click(within(sections).getByRole("button", { name: /rules/i }));
  return user;
}

afterEach(() => {
  cleanup();
  ruleCache.rules = [];
  ruleCache.listeners.clear();
  ruleCache.updateOptions = undefined;
  ruleCache.invalidate.mockReset();
});

describe("compliance rules", () => {
  it("flips the toggle label before the mutation settles", async () => {
    ruleCache.rules = [buildRule({ id: "rule-1" })];
    const user = await renderRulesSection();

    await user.click(screen.getByRole("button", { name: "Pause rule" }));

    expect(
      screen.getByRole("button", { name: "Enable rule" }),
    ).toBeInTheDocument();
    expect(screen.getByText("paused")).toBeInTheDocument();
  });

  it("keeps the open editor when another rule is toggled", async () => {
    ruleCache.rules = [
      buildRule({ id: "rule-1", title: "Utilities below routers" }),
      buildRule({ id: "rule-2", title: "No secrets in fixtures" }),
    ];
    const user = await renderRulesSection();

    const editors = screen.getAllByRole("button", { name: "Edit" });
    await user.click(editors[0] as HTMLElement);
    const toggles = screen.getAllByRole("button", { name: "Pause rule" });
    await user.click(toggles[1] as HTMLElement);
    act(() =>
      ruleCache.updateOptions?.onSuccess?.(undefined, {
        monitorId: "monitor-1",
        ruleId: "rule-2",
      }),
    );

    expect(screen.getByLabelText("Rule name")).toHaveValue(
      "Utilities below routers",
    );
    expect(ruleCache.invalidate).toHaveBeenCalledWith({
      monitorId: "monitor-1",
    });
  });
});
