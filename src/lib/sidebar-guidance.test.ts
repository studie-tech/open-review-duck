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
        localMode: false,
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
        localMode: false,
      }),
    ).toMatchObject({ kind: "ai", href: "/settings/ai" });
  });

  it("does not advertise account-free AI in a local workspace", () => {
    expect(
      sidebarGuidance({
        hasProviderConnection: true,
        hasAiConfiguration: false,
        reviewedToday: false,
        currentStreak: 0,
        localMode: true,
      }),
    ).toMatchObject({
      description: "Connect a local model or add your own provider key.",
    });
  });

  it("guides local users to a provider connection", () => {
    expect(
      sidebarGuidance({
        hasProviderConnection: false,
        hasAiConfiguration: false,
        reviewedToday: false,
        currentStreak: 0,
        localMode: true,
      }),
    ).toMatchObject({
      title: "Connect your code",
      action: "Connect provider",
    });
  });

  it("shows streak guidance after onboarding", () => {
    expect(
      sidebarGuidance({
        hasProviderConnection: true,
        hasAiConfiguration: true,
        reviewedToday: false,
        currentStreak: 4,
        localMode: false,
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
        localMode: false,
      }),
    ).toBeNull();
  });
});
