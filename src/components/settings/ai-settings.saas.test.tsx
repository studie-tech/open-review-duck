// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaasAiSettings } from "./ai-settings.saas";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  configurationInvalidate: vi.fn(),
  guidanceInvalidate: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  savePending: false,
}));

type SaasSettingsProps = ComponentProps<typeof SaasAiSettings>;
type SaasConfiguration = SaasSettingsProps["initialConfiguration"];
type PlanUsage = SaasSettingsProps["initialPlanUsage"];

const freeConfiguration: SaasConfiguration = {
  canEditPrompts: false,
  mode: "on_demand",
  managedModel: "provider/model",
  managedModels: ["provider/model"],
  reviewPullRequests: false,
  maxReviewTokens: null,
  deepReviewAvailable: false,
  configuration: {
    provider: "openrouter",
    model: "provider/model",
    baseUrl: null,
    useManagedModels: true,
    hasApiKey: false,
    hasHeaders: false,
  },
};

const freeUsage: PlanUsage = {
  tier: "free",
  subscribed: false,
  usedTokens: 12_500,
  limitTokens: 100_000,
  remainingTokens: 87_500,
  resetsAt: new Date("2026-09-01T00:00:00Z"),
};

/** Renders SaaS settings with concise configuration and usage variations. */
function renderSaasSettings({
  configuration = {},
  usage = {},
}: {
  configuration?: Partial<SaasConfiguration>;
  usage?: Partial<PlanUsage>;
} = {}) {
  return render(
    <SaasAiSettings
      initialConfiguration={{ ...freeConfiguration, ...configuration }}
      initialPlanUsage={{ ...freeUsage, ...usage }}
      fetchedAt={Date.now()}
    />,
  );
}

vi.mock("@clerk/nextjs", () => ({
  PricingTable: () => <div data-testid="clerk-pricing-table" />,
  Show: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@clerk/nextjs/experimental", () => ({
  SubscriptionDetailsButton: ({ children }: { children: ReactNode }) =>
    children,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: mocks.toastSuccess },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      ai: { configuration: { invalidate: mocks.configurationInvalidate } },
      workspace: { guidance: { invalidate: mocks.guidanceInvalidate } },
    }),
    ai: {
      planUsage: {
        useQuery: (_input: unknown, options: { initialData: unknown }) => ({
          data: options.initialData,
        }),
      },
      saveConfiguration: {
        useMutation: (options: { onSuccess: () => void }) => ({
          mutate: (input: unknown) => {
            mocks.save(input);
            options.onSuccess();
          },
          isPending: mocks.savePending,
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.savePending = false;
});

describe("SaasAiSettings", () => {
  it("shows usage and Clerk billing without a model picker", async () => {
    const user = userEvent.setup();
    renderSaasSettings();

    expect(
      screen.getByRole("heading", {
        name: "Usage, preferences, and billing",
      }),
    ).toBeVisible();
    expect(screen.getByText("12,500")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Plans" })).toBeVisible();
    expect(screen.getByTestId("clerk-pricing-table")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Monthly token usage" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Assistant preferences" }),
    ).toBeVisible();
    expect(
      screen.getByText(/spend tokens.*fixed by the SaaS deployment/i),
    ).toBeVisible();
    expect(
      screen
        .getByRole("heading", { name: "Monthly token usage" })
        .closest("section"),
    ).toHaveClass("h-full");
    expect(
      screen
        .getByRole("heading", { name: "Assistant preferences" })
        .closest("section"),
    ).toHaveClass("h-full");
    expect(screen.queryByText("Managed model")).not.toBeInTheDocument();
    expect(screen.queryByText("Model prompts")).not.toBeInTheDocument();
    expect(screen.getByText("Tokens per review")).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(
      screen.getByText(/Pull-request review is a Pro capability/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save preferences" }),
    ).toBeDisabled();

    await user.selectOptions(
      screen.getByRole("combobox", { name: /Assistance timing/ }),
      "automatic",
    );
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(mocks.save).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "provider/model",
      clearApiKey: false,
      clearHeaders: false,
      headers: {},
      useManagedModels: true,
      mode: "automatic",
      reviewPullRequests: false,
      maxReviewTokens: null,
    });
    expect(mocks.configurationInvalidate).toHaveBeenCalledOnce();
    expect(mocks.guidanceInvalidate).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("AI preferences saved");
  });

  it("shows subscription management without the upgrade table for Pro", () => {
    renderSaasSettings({
      configuration: {
        mode: "automatic",
        reviewPullRequests: true,
        maxReviewTokens: 50_000,
        deepReviewAvailable: true,
      },
      usage: {
        tier: "pro",
        subscribed: true,
        usedTokens: 500_000,
        limitTokens: 20_000_000,
        remainingTokens: 19_500_000,
      },
    });

    expect(screen.getByText("Pro")).toBeVisible();
    expect(
      screen.getByText("20,000,000 managed AI tokens each month for $20 USD."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Manage subscription" }),
    ).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeEnabled();
    expect(
      screen.queryByText(/Pull-request review is a Pro capability/),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("clerk-pricing-table")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Plans" }),
    ).not.toBeInTheDocument();
  });

  it("validates and normalizes the token cap before saving", async () => {
    const user = userEvent.setup();
    renderSaasSettings({
      configuration: {
        reviewPullRequests: true,
        deepReviewAvailable: true,
      },
      usage: {
        tier: "pro",
        subscribed: true,
        usedTokens: 0,
        limitTokens: 20_000_000,
        remainingTokens: 20_000_000,
      },
    });

    const tokenCap = screen.getByRole("textbox", {
      name: /Tokens per review/,
    });
    await user.type(tokenCap, "1.5");
    expect(screen.getByText(/Enter a whole number of tokens/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save preferences" }),
    ).toBeDisabled();

    await user.clear(tokenCap);
    await user.type(tokenCap, "25000");
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ maxReviewTokens: 25_000 }),
    );
  });

  it("disables the shared form and save action while saving", () => {
    mocks.savePending = true;
    renderSaasSettings({
      configuration: {
        reviewPullRequests: true,
        maxReviewTokens: 50_000,
        deepReviewAvailable: true,
      },
      usage: {
        tier: "pro",
        subscribed: true,
        usedTokens: 0,
        limitTokens: 20_000_000,
        remainingTokens: 20_000_000,
      },
    });

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
      screen.getByRole("button", { name: "Save preferences" }),
    ).toBeDisabled();
  });
});
