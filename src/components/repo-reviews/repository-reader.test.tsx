// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CommandCenterItem,
  useCommandCenterBindings,
} from "~/components/command-center";
import { PageCommandCenterProvider } from "~/components/page-command-center";

const navigateSpy = vi.hoisted(() => vi.fn());
const mutationSpies = vi.hoisted(() => ({
  addRuleMutate: vi.fn(),
  signOffMutate: vi.fn(),
  signOffOptions: vi.fn(),
  signOffIsPending: vi.fn(() => false),
  unreviewMutate: vi.fn(),
}));
const sourceHydrationSpies = vi.hoisted(() => ({
  hydrate: vi.fn(
    async (
      sources: Array<{ path: string; source: string }>,
      _snapshotId: string,
      _cache: Map<string, Promise<Uint8Array>>,
      _concurrency: number,
      _signal?: AbortSignal,
      onHydrated?: (
        index: number,
        source: { path: string; source: string },
      ) => void,
    ) => {
      const units = sources.map((source, index) => {
        const hydrated = {
          ...source,
          source: source.source || `hydrated ${source.path}`,
        };
        onHydrated?.(index, hydrated);
        return hydrated;
      });
      return {
        failures: [],
        successfulIndexes: units.map((_unit, index) => index),
        units,
      };
    },
  ),
}));

vi.mock("~/lib/private-source-client", () => ({
  hydratePrivateReviewSources: sourceHydrationSpies.hydrate,
  prioritizePrivateReviewSources: <Source,>(sources: readonly Source[]) => [
    ...sources,
  ],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigateSpy }),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      repoReviews: { rules: { invalidate: vi.fn() } },
    }),
    repoReviews: {
      addRule: {
        useMutation: () => ({
          mutate: mutationSpies.addRuleMutate,
          isPending: false,
        }),
      },
    },
    review: {
      signOffFile: {
        useMutation: (options: unknown) => {
          mutationSpies.signOffOptions(options);
          return {
            mutate: mutationSpies.signOffMutate,
            isPending: mutationSpies.signOffIsPending(),
            variables: undefined,
          };
        },
      },
      unreviewFile: {
        useMutation: () => ({
          mutate: mutationSpies.unreviewMutate,
          isPending: false,
          variables: undefined,
        }),
      },
    },
  },
}));

import { RepositoryReader } from "./repository-reader";

const monitor = {
  id: "monitor-1",
  repositoryOwner: "reviewduck",
  repositoryName: "hub-app",
  branch: "main",
};

let sequence = 0;
/** Builds one reading-path unit with defaults suited to the text grammar. */
function makeUnit(
  overrides: Partial<
    ComponentProps<typeof RepositoryReader>["initialData"]["units"][number]
  > = {},
) {
  sequence += 1;
  const base = {
    id: `unit-${sequence}`,
    pullRequestId: "pr-1",
    snapshotId: "snapshot-1",
    snapshotFileId: `file-${sequence}`,
    path: `src/unit${sequence}.ts`,
    name: `unitName${sequence}`,
    kind: "function",
    status: "pending",
    startLine: 1,
    endLine: 3,
    language: "text",
    source: `source of ${sequence}\nline two\nline three\n`,
    previousSource: null,
    changeType: "modified",
    changedLineCount: 3,
    changedSinceSignOff: false,
    requiresReReview: false,
    revisionState: "initial",
    signOffOrigin: "none",
    waitingSince: null,
    relatedRanges: [],
  };
  return { ...base, ...overrides };
}

type ReaderData = ComponentProps<typeof RepositoryReader>["initialData"];

/** Wraps plain units in the workspace payload the reader expects. */
function makeData(units: ReturnType<typeof makeUnit>[]): ReaderData {
  return {
    units,
    fileContexts: [],
    sourceDelivery: "embedded",
    snapshot: null,
  } as unknown as ReaderData;
}

/**
 * Mirrors the app-shell wiring so registered reader commands receive real
 * keyboard events during the test.
 */
function ShellHarness({
  children,
  onRegister,
}: {
  children: React.ReactNode;
  onRegister?: (commands: CommandCenterItem[]) => void;
}) {
  const [registered, setRegistered] = useState<CommandCenterItem[][]>([]);
  const register = useCallback(
    (next: CommandCenterItem[]) => {
      onRegister?.(next);
      setRegistered((current) =>
        current.includes(next) ? current : [...current, next],
      );
      return () =>
        setRegistered((current) => current.filter((item) => item !== next));
    },
    [onRegister],
  );
  const commands = registered.flat();
  const pendingShortcut = useCommandCenterBindings({
    commands,
    onOpen: () => {},
    onOpenShortcuts: () => {},
  });
  return (
    <PageCommandCenterProvider value={{ pendingShortcut, register }}>
      {children}
    </PageCommandCenterProvider>
  );
}

afterEach(() => {
  cleanup();
  sequence = 0;
  vi.clearAllMocks();
  mutationSpies.signOffIsPending.mockReturnValue(false);
});

describe("RepositoryReader", () => {
  it("renders as a fixed viewport takeover with an always-visible action footer", () => {
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([makeUnit()])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    expect(document.querySelector(".fixed.inset-0")).not.toBeNull();
    expect(screen.getByRole("button", { name: /sign off/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /previous/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /next/i })).toBeVisible();
    expect(
      screen.getByText("reviewduck/hub-app", { selector: "div" }),
    ).toBeVisible();
  });

  it("labels the branch with the head sha of the loaded snapshot", () => {
    const data = makeData([makeUnit()]);
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={
            {
              ...data,
              snapshot: { id: "snapshot-1", headSha: "abcdef1234567890" },
            } as unknown as ReaderData
          }
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    expect(screen.getByText("abcdef1")).toBeVisible();
  });

  it("registers command-center entries for stepping, queue resume, and sign-off", () => {
    const registrations: CommandCenterItem[][] = [];
    render(
      <ShellHarness onRegister={(commands) => registrations.push(commands)}>
        <RepositoryReader
          initialData={makeData([
            makeUnit(),
            makeUnit(),
            makeUnit({ status: "signed_off" }),
          ])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    expect(registrations.length).toBeGreaterThan(0);
    const ids = registrations.at(-1)?.map(({ id }) => id) ?? [];
    expect(ids).toContain("reader-sign-off");
    expect(ids).toContain("reader-next-file");
    expect(ids).toContain("reader-next-pending");
    // The active unit is unread, so marking unread starts disabled.
    const entries = registrations.at(-1) ?? [];
    expect(
      entries.find(({ id }) => id === "reader-mark-unread")?.disabled,
    ).toBe(true);
  });

  it("creates a compliance rule from a selected source range", () => {
    const unit = makeUnit({ path: "src/policy.ts", startLine: 10 });
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([unit])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Create compliance rule from line 10",
      }),
    );
    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Authorize protected operations" },
    });
    fireEvent.change(screen.getByLabelText("Rule instruction"), {
      target: { value: "Require an authorization check before mutations." },
    });
    fireEvent.change(screen.getByLabelText("Rule path glob"), {
      target: { value: "src/**/*.ts" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Create compliance rule from line 12",
      }),
      { shiftKey: true },
    );
    expect(screen.getByText(/lines 10–12/i)).toBeVisible();
    expect(screen.getByLabelText("Rule name")).toHaveValue(
      "Authorize protected operations",
    );
    expect(screen.getByLabelText("Rule instruction")).toHaveValue(
      "Require an authorization check before mutations.",
    );
    expect(screen.getByLabelText("Rule path glob")).toHaveValue("src/**/*.ts");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(mutationSpies.addRuleMutate).toHaveBeenCalledWith({
      monitorId: monitor.id,
      title: "Authorize protected operations",
      instruction: "Require an authorization check before mutations.",
      pathGlob: "src/**/*.ts",
      scope: "file",
      severity: "medium",
    });
  });

  it("hydrates full-file context only for the active direct-source path", async () => {
    const first = makeUnit({ path: "src/one.ts" });
    const second = makeUnit({ path: "src/two.ts" });
    const data = makeData([first, second]);
    data.sourceDelivery = "direct";
    data.snapshot = {
      id: "snapshot-1",
      headSha: "abcdef1234567890",
    } as ReaderData["snapshot"];
    data.fileContexts = [
      { ...first, id: "context-one", kind: "file", source: "" },
      { ...second, id: "context-two", kind: "file", source: "" },
    ] as ReaderData["fileContexts"];

    render(
      <ShellHarness>
        <RepositoryReader initialData={data} monitor={monitor as never} />
      </ShellHarness>,
    );

    await waitFor(() => {
      expect(sourceHydrationSpies.hydrate).toHaveBeenCalledTimes(2);
    });
    const sourceLists = sourceHydrationSpies.hydrate.mock.calls.map(
      ([sources]) => sources.map(({ path }) => path),
    );
    expect(sourceLists).toContainEqual(["src/one.ts", "src/two.ts"]);
    expect(sourceLists).toContainEqual(["src/one.ts"]);
    expect(sourceLists.filter((paths) => paths.length > 1)).toEqual([
      ["src/one.ts", "src/two.ts"],
    ]);

    fireEvent.click(screen.getByRole("button", { name: /two\.ts/i }));
    await waitFor(() => {
      expect(sourceHydrationSpies.hydrate).toHaveBeenCalledTimes(3);
    });
    expect(sourceHydrationSpies.hydrate.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ path: "src/two.ts" }),
    ]);
  });

  it("shows each file once, groups its units in one card, and steps by file", async () => {
    const first = makeUnit({
      path: "src/a.ts",
      snapshotFileId: "file-a",
      name: "firstMember",
      startLine: 1,
      endLine: 2,
    });
    const second = makeUnit({
      path: "src/a.ts",
      snapshotFileId: "file-a",
      name: "secondMember",
      startLine: 4,
      endLine: 5,
    });
    const third = makeUnit({
      path: "src/b.ts",
      snapshotFileId: "file-b",
      name: "thirdMember",
      source: "third file source\n",
    });
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([first, second, third])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    expect(screen.getAllByRole("button", { name: /a\.ts/i })).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByText("firstMember")).toBeVisible();
      expect(screen.getByText("secondMember")).toBeVisible();
    });
    expect(screen.getByText(/2 review units · 0\/2 reviewed/i)).toBeVisible();
    fireEvent.keyDown(document, {
      key: "ArrowDown",
      ctrlKey: true,
    });
    // A one-unit file card does not paint a member-name marker.
    expect(screen.getByText("third file source")).toBeVisible();
    expect(screen.queryByText("firstMember")).toBeNull();
    fireEvent.keyDown(document, { key: "ArrowUp", ctrlKey: true });
    expect(screen.getByText("firstMember")).toBeVisible();
    expect(screen.getByText("secondMember")).toBeVisible();
  });

  it("reveals surrounding file context with the PR review shortcuts", () => {
    const unit = makeUnit({
      path: "src/context.ts",
      source: "focus three\nfocus four",
      startLine: 3,
      endLine: 4,
    });
    const data = makeData([unit]);
    data.fileContexts = [
      {
        ...unit,
        id: "file-context-1",
        kind: "file",
        source:
          "above one\nabove two\nfocus three\nfocus four\nbelow five\nbelow six",
        startLine: 1,
        endLine: 6,
      },
    ] as ReaderData["fileContexts"];
    render(
      <ShellHarness>
        <RepositoryReader initialData={data} monitor={monitor as never} />
      </ShellHarness>,
    );
    expect(screen.queryByText("above one")).toBeNull();
    expect(screen.queryByText("below six")).toBeNull();

    fireEvent.keyDown(document, { key: "c" });
    expect(screen.getByText("above one")).toBeVisible();
    expect(screen.getByText("below six")).toBeVisible();
    expect(screen.getByRole("button", { name: /hide context/i })).toBeVisible();

    fireEvent.keyDown(document, { key: "c" });
    expect(screen.queryByText("above one")).toBeNull();
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    expect(screen.queryByText("above one")).toBeNull();
    expect(screen.getByText("below six")).toBeVisible();
  });

  it("signs off every unit in the active file with one mutation", () => {
    const first = makeUnit({
      path: "src/grouped.ts",
      snapshotFileId: "file-grouped",
    });
    const second = makeUnit({
      path: "src/grouped.ts",
      snapshotFileId: "file-grouped",
    });
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([first, second])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    fireEvent.keyDown(document, { key: "s" });
    expect(mutationSpies.signOffMutate).toHaveBeenCalledWith({
      snapshotFileId: "file-grouped",
      durationSeconds: 0,
    });
    expect(screen.getByText(/2 review units · 2\/2 reviewed/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /return file/i })).toBeDisabled();
    const options = mutationSpies.signOffOptions.mock.calls.at(-1)?.[0] as {
      onSuccess: (result: {
        snapshotFileId: string;
        signedUnitIds: string[];
      }) => void;
    };
    act(() => {
      options.onSuccess({
        snapshotFileId: "file-grouped",
        signedUnitIds: [first.id, second.id],
      });
    });
    expect(screen.getByRole("button", { name: /return file/i })).toBeEnabled();
  });

  it("keeps a file visibly pending and prevents duplicate submissions", () => {
    const first = makeUnit({ snapshotFileId: "file-pending" });
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([first])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    fireEvent.keyDown(document, { key: "s" });
    fireEvent.keyDown(document, { key: "s" });
    expect(mutationSpies.signOffMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /return file/i })).toBeDisabled();
  });

  it("returns every reviewed unit in a file to review together", () => {
    const unit = makeUnit({
      status: "signed_off",
      snapshotFileId: "file-reviewed",
    });
    const registrations: CommandCenterItem[][] = [];
    render(
      <ShellHarness onRegister={(commands) => registrations.push(commands)}>
        <RepositoryReader
          initialData={makeData([unit])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    const command = registrations
      .at(-1)
      ?.find(({ id }) => id === "reader-mark-unread");
    expect(command?.disabled).toBe(false);
    command?.onSelect();
    expect(mutationSpies.unreviewMutate).toHaveBeenCalledWith({
      snapshotFileId: "file-reviewed",
    });
  });

  it("focuses the path search with the search stroke and clears it on Escape", async () => {
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([makeUnit(), makeUnit({ name: "needle" })])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    fireEvent.keyDown(document, { key: "f" });
    const search = screen.getByLabelText("Find a file");
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    fireEvent.change(search, { target: { value: "zzz-no-match" } });
    expect(screen.getByText(/No repository files match/)).toBeVisible();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => {
      expect(search).not.toHaveFocus();
    });
    expect(search).toHaveValue("");
    expect(screen.queryByText(/No repository files match/)).toBeNull();
  });

  it("toggles the review path panel with the panel stroke", () => {
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([makeUnit()])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    expect(screen.getByLabelText("Find a file")).toBeVisible();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.queryByLabelText("Find a file")).toBeNull();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.getByLabelText("Find a file")).toBeVisible();
  });

  it("shows the previous revision when the unit carries one", async () => {
    const user = userEvent.setup();
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([
            makeUnit({ previousSource: "old source line\n", startLine: 7 }),
          ])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    await user.click(
      screen.getByRole("button", { name: /previous revision/i }),
    );
    expect(screen.getByText("old source line")).toBeVisible();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.queryByText(/source of/)).toBeNull();
  });

  it("renders the completion state when no readable units exist", () => {
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    expect(screen.getByText("No reviewable source units")).toBeVisible();
  });

  it("keeps the sign-off stroke inert while typing in the path search", async () => {
    const user = userEvent.setup();
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([makeUnit()])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    await user.click(screen.getByLabelText("Find a file"));
    await user.type(screen.getByLabelText("Find a file"), "s");
    expect(mutationSpies.signOffMutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Find a file")).toHaveValue("s");
  });
});
