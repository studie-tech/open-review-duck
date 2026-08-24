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
      signOff: {
        useMutation: (options: unknown) => {
          mutationSpies.signOffOptions(options);
          return {
            mutate: mutationSpies.signOffMutate,
            isPending: mutationSpies.signOffIsPending(),
            variables: undefined,
          };
        },
      },
      unreview: {
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
  snapshot: { headSha: "abcdef1234567890" },
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
    changedSinceSignOff: false,
    requiresReReview: false,
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
    expect(ids).toContain("reader-next-unit");
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
    fireEvent.click(
      screen.getByRole("button", {
        name: "Create compliance rule from line 12",
      }),
      { shiftKey: true },
    );
    expect(screen.getByText(/lines 10–12/i)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Authorize protected operations" },
    });
    fireEvent.change(screen.getByLabelText("Rule instruction"), {
      target: { value: "Require an authorization check before mutations." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(mutationSpies.addRuleMutate).toHaveBeenCalledWith({
      monitorId: monitor.id,
      title: "Authorize protected operations",
      instruction: "Require an authorization check before mutations.",
      pathGlob: "src/policy.ts",
      scope: "file",
      severity: "medium",
    });
  });

  it("steps between units with the next-unit stroke and jumps whole files", () => {
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([
            makeUnit({ path: "src/a.ts" }),
            makeUnit({ path: "src/a.ts" }),
            makeUnit({ path: "src/b.ts" }),
          ])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    expect(screen.getAllByText(/unitName1 ·/).length).toBeGreaterThan(0);
    fireEvent.keyDown(document, {
      key: "ArrowDown",
      ctrlKey: true,
    });
    expect(screen.getAllByText(/unitName2 ·/).length).toBeGreaterThan(0);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getAllByText(/unitName3 ·/).length).toBeGreaterThan(0);
    // Back one file lands on that file's first unit, not the unit stepped from.
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getAllByText(/unitName2 ·/).length).toBeGreaterThan(0);
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

  it("marks the active unit read and advances optimistically", () => {
    const first = makeUnit();
    const { container } = render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([first, makeUnit()])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    fireEvent.keyDown(document, { key: "s" });
    expect(mutationSpies.signOffMutate).toHaveBeenCalledWith({
      unitId: first.id,
      durationSeconds: 0,
    });
    const options = mutationSpies.signOffOptions.mock.calls.at(-1)?.[0] as {
      onMutate: (variables: { unitId: string }) => unknown;
    };
    act(() => {
      options.onMutate({ unitId: first.id });
    });
    expect(container.querySelector("[aria-current='true']")).not.toBeNull();
    expect(screen.getAllByText(/unitName2 ·/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /sign off/i })).toBeEnabled();
  });

  it("shows background save progress without waiting before advancing", () => {
    const first = makeUnit();
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([first, makeUnit()])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    const options = mutationSpies.signOffOptions.mock.calls.at(-1)?.[0] as
      | {
          onMutate: (variables: { unitId: string }) => unknown;
          onSettled: (
            result: unknown,
            error: unknown,
            variables: { unitId: string },
          ) => void;
        }
      | undefined;
    if (!options) throw new Error("sign-off mutation was not registered");
    act(() => {
      options.onMutate({ unitId: first.id });
    });
    expect(screen.getAllByText(/unitName2 ·/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("status", { name: /saving reviews, 0\/1/i }),
    ).toBeVisible();
    act(() => {
      options.onSettled(undefined, undefined, { unitId: first.id });
    });
    expect(screen.getAllByText(/unitName2 ·/).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("status", { name: /saving reviews/i }),
    ).toBeNull();
  });

  it("expands save progress when several sign-offs are queued", () => {
    const first = makeUnit();
    const second = makeUnit();
    render(
      <ShellHarness>
        <RepositoryReader
          initialData={makeData([first, second, makeUnit()])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    const firstOptions = mutationSpies.signOffOptions.mock.calls.at(
      -1,
    )?.[0] as {
      onMutate: (variables: { unitId: string }) => unknown;
    };
    act(() => {
      firstOptions.onMutate({ unitId: first.id });
    });
    const secondOptions = mutationSpies.signOffOptions.mock.calls.at(
      -1,
    )?.[0] as {
      onMutate: (variables: { unitId: string }) => unknown;
    };
    act(() => {
      secondOptions.onMutate({ unitId: second.id });
    });
    expect(
      screen.getByRole("status", { name: /saving reviews, 0\/2/i }),
    ).toBeVisible();
  });

  it("prevents marking a unit unread while a sign-off is pending", () => {
    const unit = makeUnit({ status: "signed_off" });
    const registrations: CommandCenterItem[][] = [];
    render(
      <ShellHarness onRegister={(commands) => registrations.push(commands)}>
        <RepositoryReader
          initialData={makeData([unit])}
          monitor={monitor as never}
        />
      </ShellHarness>,
    );
    const options = mutationSpies.signOffOptions.mock.calls.at(-1)?.[0] as {
      onMutate: (variables: { unitId: string }) => unknown;
    };
    act(() => {
      options.onMutate({ unitId: unit.id });
    });
    expect(screen.getByRole("button", { name: /mark unread/i })).toBeDisabled();
    const command = registrations
      .at(-1)
      ?.find(({ id }) => id === "reader-mark-unread");
    expect(command?.disabled).toBe(true);
    command?.onSelect();
    expect(mutationSpies.unreviewMutate).not.toHaveBeenCalled();
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
    const search = screen.getByLabelText("Find file or symbol");
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    fireEvent.change(search, { target: { value: "zzz-no-match" } });
    expect(screen.getByText(/No files or symbols match/)).toBeVisible();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => {
      expect(search).not.toHaveFocus();
    });
    expect(search).toHaveValue("");
    expect(screen.queryByText(/No files or symbols match/)).toBeNull();
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
    expect(screen.getByLabelText("Find file or symbol")).toBeVisible();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.queryByLabelText("Find file or symbol")).toBeNull();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    expect(screen.getByLabelText("Find file or symbol")).toBeVisible();
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
    await user.click(screen.getByLabelText("Find file or symbol"));
    await user.type(screen.getByLabelText("Find file or symbol"), "s");
    expect(mutationSpies.signOffMutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Find file or symbol")).toHaveValue("s");
  });
});
