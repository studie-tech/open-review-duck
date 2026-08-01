export interface SidebarGuidanceState {
  hasProviderConnection: boolean;
  hasAiConfiguration: boolean;
  reviewedToday: boolean;
  currentStreak: number;
  localMode: boolean;
}

export interface SidebarGuidanceCard {
  kind: "provider" | "ai" | "streak";
  eyebrow: string;
  title: string;
  description: string;
  action: string;
  href: string;
}

/** Chooses the next contextual onboarding prompt for the dashboard sidebar. */
export function sidebarGuidance(
  state: SidebarGuidanceState,
): SidebarGuidanceCard | null {
  if (!state.hasProviderConnection) {
    return {
      kind: "provider",
      eyebrow: "Get started · 1 of 2",
      title: "Connect your code",
      description: "Add GitHub, GitLab, or Azure DevOps to start reviewing.",
      action: "Connect provider",
      href: "/settings/providers",
    };
  }

  if (!state.hasAiConfiguration) {
    return {
      kind: "ai",
      eyebrow: "Get started · 2 of 2",
      title: "Configure AI assistance",
      description: state.localMode
        ? "Enable optional Big Pickle or connect a local model."
        : "Choose a managed subscriber model for explanations.",
      action: "Set up AI",
      href: "/settings/ai",
    };
  }

  if (state.reviewedToday) return null;

  return {
    kind: "streak",
    eyebrow:
      state.currentStreak > 0
        ? `Review streak · ${state.currentStreak} ${state.currentStreak === 1 ? "day" : "days"}`
        : "Review streak",
    title:
      state.currentStreak > 0 ? "Keep your streak going" : "Start your streak",
    description:
      "Sign off one review unit today to build your review practice.",
    action: "Open reviews",
    href: "/dashboard",
  };
}
