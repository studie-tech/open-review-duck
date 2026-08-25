// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAiSettings } from "./ai-settings.local";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  test: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("./ai-prompt-editor", () => ({
  AiPromptEditor: () => <div>Model prompts</div>,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      ai: { configuration: { invalidate: vi.fn() } },
      workspace: { guidance: { invalidate: vi.fn() } },
    }),
    ai: {
      testConfiguration: {
        useMutation: () => ({
          mutateAsync: mocks.test,
          isPending: false,
        }),
      },
      saveConfiguration: {
        useMutation: () => ({
          mutate: mocks.save,
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

describe("LocalAiSettings", () => {
  it("uses the full-width SaaS layout with preferences and provider cards", () => {
    render(
      <LocalAiSettings
        initialConfiguration={{
          canEditPrompts: false,
          mode: "on_demand",
          managedModel: "gpt-4.1-mini",
          managedModels: ["gpt-4.1-mini"],
          reviewPullRequests: true,
          maxReviewTokens: null,
          deepReviewAvailable: true,
          configuration: {
            provider: "openai",
            model: "gpt-4.1-mini",
            baseUrl: "https://api.openai.com/v1",
            useManagedModels: false,
            hasApiKey: true,
            hasHeaders: false,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "AI that supports your judgment" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Provider status" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Assistant preferences" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Model provider" }),
    ).toBeVisible();
    expect(screen.getByText("OpenAI · gpt-4.1-mini")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Review the full pull request" }),
    ).toBeEnabled();
    expect(screen.queryByText(/monthly plan tokens/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Save & use model" }),
    ).toBeDisabled();
    expect(screen.queryByText("Model prompts")).not.toBeInTheDocument();
  });

  it("shows the prompt editor for an administrator", () => {
    render(
      <LocalAiSettings
        initialConfiguration={{
          canEditPrompts: true,
          mode: "on_demand",
          managedModel: "gpt-4.1-mini",
          managedModels: ["gpt-4.1-mini"],
          reviewPullRequests: true,
          maxReviewTokens: null,
          deepReviewAvailable: true,
          configuration: {
            provider: "openai",
            model: "gpt-4.1-mini",
            baseUrl: "https://api.openai.com/v1",
            useManagedModels: false,
            hasApiKey: true,
            hasHeaders: false,
          },
        }}
      />,
    );

    expect(screen.getByText("Model prompts")).toBeVisible();
  });

  it("starts with no provider selected when none is saved", () => {
    render(
      <LocalAiSettings
        initialConfiguration={{
          canEditPrompts: false,
          mode: "on_demand",
          managedModel: "",
          managedModels: [""],
          reviewPullRequests: false,
          maxReviewTokens: null,
          deepReviewAvailable: true,
          configuration: null,
        }}
      />,
    );

    expect(screen.getByText("No provider saved")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("");
    expect(
      screen.getByRole("option", { name: "Select a provider" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeDisabled();
  });
});
