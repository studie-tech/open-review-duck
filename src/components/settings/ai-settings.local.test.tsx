// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAiSettings } from "./ai-settings.local";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  test: vi.fn(),
  savePending: false,
}));

type LocalConfiguration = ComponentProps<
  typeof LocalAiSettings
>["initialConfiguration"];

const configuredLocalAi: LocalConfiguration = {
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
};

/** Builds a local AI configuration with only the relevant test variation. */
function localConfiguration(
  overrides: Partial<LocalConfiguration> = {},
): LocalConfiguration {
  return { ...configuredLocalAi, ...overrides };
}

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
          isPending: mocks.savePending,
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.test.mockReset();
  mocks.savePending = false;
});

describe("LocalAiSettings", () => {
  it("uses the full-width SaaS layout with preferences and provider cards", () => {
    render(<LocalAiSettings initialConfiguration={localConfiguration()} />);

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
      screen.getByText(/call your provider.*save with the connection/i),
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
        initialConfiguration={localConfiguration({ canEditPrompts: true })}
      />,
    );

    expect(screen.getByText("Model prompts")).toBeVisible();
  });

  it("starts with no provider selected when none is saved", () => {
    render(
      <LocalAiSettings
        initialConfiguration={localConfiguration({
          managedModel: "",
          managedModels: [""],
          reviewPullRequests: false,
          deepReviewAvailable: false,
          configuration: null,
        })}
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
    expect(
      screen.getByRole("checkbox", { name: "Review the full pull request" }),
    ).toBeDisabled();
    expect(
      screen.getByText("This deployment cannot run a pull-request review."),
    ).toBeVisible();
  });

  it("guides Bedrock and Azure AI Foundry OpenAI-compatible setup", async () => {
    const user = userEvent.setup();
    render(
      <LocalAiSettings
        initialConfiguration={localConfiguration({
          managedModel: "",
          managedModels: [""],
          configuration: null,
        })}
      />,
    );

    const provider = screen.getByRole("combobox", { name: "Provider" });
    await user.selectOptions(provider, "bedrock");
    expect(
      screen.getByPlaceholderText(
        "https://bedrock-runtime.<region>.amazonaws.com/openai/v1",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Amazon Bedrock API key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByText(/model's AWS Region/)).toBeVisible();

    await user.selectOptions(provider, "azure_foundry");
    expect(
      screen.getByPlaceholderText(
        "https://<resource>.openai.azure.com/openai/v1",
      ),
    ).toBeVisible();
    expect(screen.getByPlaceholderText("Deployment name")).toBeVisible();
    expect(screen.getByLabelText("Foundry resource API key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.getByText(
        /deployment name, not the catalog model ID.*supports Chat Completions/,
      ),
    ).toBeVisible();
  });

  it("validates and saves the shared preference draft in the BYOK payload", async () => {
    const user = userEvent.setup();
    mocks.test.mockResolvedValueOnce({ ok: true, latencyMs: 42 });
    render(<LocalAiSettings initialConfiguration={localConfiguration()} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /Assistance timing/ }),
      "automatic",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Review the full pull request" }),
    );
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save & use model" }),
      ).toBeEnabled(),
    );

    const tokenCap = screen.getByRole("textbox", {
      name: /Tokens per review/,
    });
    await user.type(tokenCap, "12.5");
    expect(screen.getByText(/Enter a whole number of tokens/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save & use model" }),
    ).toBeDisabled();

    await user.clear(tokenCap);
    await user.type(tokenCap, "12345");
    await user.click(screen.getByRole("button", { name: "Save & use model" }));

    expect(mocks.save).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4.1-mini",
      apiKey: undefined,
      clearApiKey: false,
      clearHeaders: false,
      headers: {},
      baseUrl: "https://api.openai.com/v1",
      useManagedModels: false,
      mode: "automatic",
      reviewPullRequests: false,
      maxReviewTokens: 12_345,
    });
  });

  it("disables shared preferences while the provider save is pending", () => {
    mocks.savePending = true;
    render(
      <LocalAiSettings
        initialConfiguration={localConfiguration({
          maxReviewTokens: 10_000,
        })}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: /Assistance timing/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Review the full pull request" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: /Tokens per review/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save & use model" }),
    ).toBeDisabled();
  });
});
