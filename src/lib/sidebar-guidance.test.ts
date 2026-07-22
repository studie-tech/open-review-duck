import { describe, expect, it } from "vitest";
import { sidebarGuidance } from "./sidebar-guidance";

describe("sidebar guidance", () => {
  it("starts by guiding a new user to code providers", () => {
    expect(
      sidebarGuidance({
        hasProviderConnection: false,
        hasAiConfiguration: false,
        reviewedToday: false,
        currentStreak: 0,
      }),
    ).toMatchObject({ kind: "provider", href: "/settings/providers" });
  });

  it("guides connected users to AI configuration next", () => {
    expect(
      sidebarGuidance({
        hasProviderConnection: true,
        hasAiConfiguration: false,
        reviewedToday: false,
        currentStreak: 0,
      }),
    ).toMatchObject({ kind: "ai", href: "/settings/ai" });
  });

  it("shows streak guidance after onboarding", () => {
    expect(
      sidebarGuidance({
        hasProviderConnection: true,
        hasAiConfiguration: true,
        reviewedToday: false,
        currentStreak: 4,
      }),
    ).toMatchObject({
      kind: "streak",
      eyebrow: "Review streak · 4 days",
    });
  });

  it("hides after a review unit is signed off today", () => {
    expect(
      sidebarGuidance({
        hasProviderConnection: true,
        hasAiConfiguration: true,
        reviewedToday: true,
        currentStreak: 4,
      }),
    ).toBeNull();
  });
});
