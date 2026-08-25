// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_PROMPT_CATALOG, AI_PROMPT_KEYS } from "~/config/ai-prompt-catalog";
import { AiPromptEditor } from "./ai-prompt-editor";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      ai: { prompts: { invalidate: vi.fn() } },
    }),
    ai: {
      prompts: {
        useQuery: () => ({
          data: AI_PROMPT_KEYS.map((key) => ({
            ...AI_PROMPT_CATALOG[key],
            body: `body:${key}`,
            defaultBody: `body:${key}`,
            modified: false,
          })),
          isPending: false,
          error: null,
        }),
      },
      savePrompt: {
        useMutation: () => ({
          mutate: mocks.save,
          isPending: false,
        }),
      },
      restorePrompt: {
        useMutation: () => ({
          mutate: mocks.restore,
          isPending: false,
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AiPromptEditor", () => {
  it("opens on the explanation pipeline and keeps save disabled until it changes", () => {
    render(<AiPromptEditor />);

    expect(
      screen.getByRole("heading", { name: "Model prompts" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Explanations" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("button", { current: "step" }),
    ).toHaveAccessibleName(/System/);
    expect(
      screen.getByRole("heading", { name: "Explanation system" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("body:explain.system");
    expect(screen.getByRole("button", { name: "Save prompt" })).toBeDisabled();
  });

  it("walks the explanation flow and the shared deep-review pipeline", async () => {
    const user = userEvent.setup();
    render(<AiPromptEditor />);

    await user.click(screen.getByRole("button", { name: "Step 3: Task" }));
    expect(screen.getByRole("textbox")).toHaveValue("body:explain.unit_task");
    expect(
      screen.getByRole("heading", { name: "Explain a unit" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Answer a question/ }));
    expect(screen.getByRole("textbox")).toHaveValue(
      "body:explain.question_task",
    );

    await user.click(screen.getByRole("tab", { name: "Deep review" }));
    expect(
      screen.getByText(/same pipeline reviews a pull request/i),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { current: "step" }),
    ).toHaveAccessibleName(/Plan/);
    expect(
      screen.getAllByText("Shared by pull requests and snapshots").length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Step 2: Scout" }));
    expect(
      screen.getByRole("button", { name: /System · repository/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Final turn/ })).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Step 3: Change type" }),
    );
    expect(screen.getByRole("button", { name: /PR deleted/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Repo current/ })).toBeVisible();
    expect(screen.queryByText("Repository review")).not.toBeInTheDocument();
  });
});
