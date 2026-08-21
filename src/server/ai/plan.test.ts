import { describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    OPENROUTER_MODEL_ALLOWLIST: "provider/model",
    MANAGED_AI_FREE_MONTHLY_TOKEN_LIMIT: 100_000,
    MANAGED_AI_PAID_MONTHLY_TOKEN_LIMIT: 20_000_000,
    MANAGED_AI_SCALE_MONTHLY_TOKEN_LIMIT: 200_000_000,
    MANAGED_AI_ULTRA_MONTHLY_TOKEN_LIMIT: 1_000_000_000,
  },
}));

import {
  managedAiMonthlyTokenLimit,
  managedAiMonthWindow,
  managedAiPlanTier,
  managedAiPlanUsage,
  managedSaasModel,
} from "./plan";

describe("managed AI plans", () => {
  it("uses the configured allowance for every plan", () => {
    expect(managedAiMonthlyTokenLimit("free")).toBe(100_000);
    expect(managedAiMonthlyTokenLimit("pro")).toBe(20_000_000);
    expect(managedAiMonthlyTokenLimit("scale")).toBe(200_000_000);
    expect(managedAiMonthlyTokenLimit("ultra")).toBe(1_000_000_000);
  });

  it("chooses the highest account entitlement", () => {
    expect(managedAiPlanTier(() => false)).toBe("free");
    expect(managedAiPlanTier((feature) => feature === "paid_ai_models")).toBe(
      "pro",
    );
    expect(
      managedAiPlanTier((feature) =>
        ["paid_ai_models", "managed_ai_scale"].includes(feature),
      ),
    ).toBe("scale");
    expect(managedAiPlanTier(() => true)).toBe("ultra");
  });

  it("returns the deployment-managed SaaS model", () => {
    expect(managedSaasModel()).toBe("provider/model");
  });

  it("resets usage at the next UTC calendar month", () => {
    expect(managedAiMonthWindow(new Date("2026-12-31T23:59:59Z"))).toEqual({
      startsAt: new Date("2026-12-01T00:00:00Z"),
      resetsAt: new Date("2027-01-01T00:00:00Z"),
    });
  });

  it("counts settled and in-flight tokens against the account allowance", async () => {
    const where = vi.fn(() =>
      Promise.resolve([
        {
          input: 20_000,
          output: 5_000,
          reservedInput: 2_000,
          reservedOutput: 1_000,
        },
      ]),
    );
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    };

    await expect(
      managedAiPlanUsage(db as never, {
        userId: "user_1",
        tier: "free",
        now: new Date("2026-08-03T12:00:00Z"),
      }),
    ).resolves.toEqual({
      tier: "free",
      subscribed: false,
      usedTokens: 28_000,
      limitTokens: 100_000,
      remainingTokens: 72_000,
      resetsAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(where).toHaveBeenCalledOnce();
  });
});
