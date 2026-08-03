// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaasAiSettings } from "./ai-settings.saas";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  configurationInvalidate: vi.fn(),
  guidanceInvalidate: vi.fn(),
  refresh: vi.fn(),
}));

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
        useMutation: () => ({ mutate: mocks.save, isPending: false }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SaasAiSettings", () => {
  it("shows usage and Clerk billing without model or disclosure controls", async () => {
    const user = userEvent.setup();
    render(
      <SaasAiSettings
        initialConfiguration={{
          mode: "on_demand",
          managedModel: "provider/model",
          managedModels: ["provider/model"],
          reviewPullRequests: false,
          configuration: {
            provider: "openrouter",
            model: "provider/model",
            baseUrl: null,
            useManagedModels: true,
            hasApiKey: false,
            hasHeaders: false,
          },
          disclosure: { accepted: false, version: "test" },
        }}
        initialPlanUsage={{
          tier: "free",
          subscribed: false,
          usedTokens: 12_500,
          limitTokens: 100_000,
          remainingTokens: 87_500,
          resetsAt: new Date("2026-09-01T00:00:00Z"),
        }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Usage, preferences, and billing",
      }),
    ).toBeVisible();
    expect(screen.getByText("12,500")).toBeVisible();
    expect(screen.getByTestId("clerk-pricing-table")).toBeVisible();
    expect(screen.queryByText("Managed model")).not.toBeInTheDocument();
    expect(screen.queryByText(/Big Pickle/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(mocks.save).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "provider/model",
      clearApiKey: false,
      clearHeaders: false,
      headers: {},
      useManagedModels: true,
      mode: "on_demand",
      reviewPullRequests: false,
    });
  });
});
