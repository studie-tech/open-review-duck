// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiUsageChip } from "./ai-usage-chip";

const queryState = vi.hoisted(() => ({
  configuration: null as null | {
    mode: "off" | "on_demand" | "automatic";
    configuration: {
      provider: string;
      useManagedModels: boolean;
    } | null;
  },
  planUsage: null as null | {
    usedTokens: number;
    limitTokens: number;
    remainingTokens: number;
    resetsAt: Date;
  },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    ai: {
      configuration: {
        useQuery: vi.fn(() => ({ data: queryState.configuration })),
      },
      planUsage: {
        useQuery: vi.fn(() => ({ data: queryState.planUsage })),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  queryState.configuration = null;
  queryState.planUsage = null;
});

describe("AiUsageChip", () => {
  it("shows compact SaaS token usage in the header control", () => {
    queryState.planUsage = {
      usedTokens: 25_000,
      limitTokens: 100_000,
      remainingTokens: 75_000,
      resetsAt: new Date("2026-09-01T00:00:00Z"),
    };

    render(<AiUsageChip deploymentMode="saas" />);

    expect(
      screen.getByRole("link", {
        name: "AI usage, 25k of 100k tokens used, 75k left · resets Sep 1",
      }),
    ).toHaveAttribute("href", "/settings/ai");
    expect(screen.getByText("25k/100k")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Monthly AI token usage" }),
    ).toHaveAttribute("aria-valuenow", "25000");
  });

  const statusCases = [
    {
      name: "disabled configuration",
      status: "Off",
      configuration: { mode: "off" as const, configuration: null },
    },
    {
      name: "unconfigured local provider",
      status: "Setup",
      configuration: { mode: "on_demand" as const, configuration: null },
    },
    {
      name: "configured local provider",
      status: "Connected",
      configuration: {
        mode: "on_demand" as const,
        configuration: { provider: "ollama", useManagedModels: false },
      },
    },
  ];

  it.each(statusCases)("shows $status for $name", (testCase) => {
    queryState.configuration = testCase.configuration;
    render(<AiUsageChip deploymentMode="local" />);

    expect(screen.getByText(testCase.status)).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: new RegExp(`AI assistant, ${testCase.status}`),
      }),
    ).toHaveAttribute("href", "/settings/ai");
  });
});
