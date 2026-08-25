"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { LinkNavigationStatus } from "~/components/ui/link-status";
import { Spinner } from "~/components/ui/spinner";
import type { DeploymentMode } from "~/lib/deployment";
import { formatTokenCount } from "~/lib/token-usage";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

/** Returns a compact local-mode label for the header AI control. */
function localAiLabel(
  configuration: RouterOutputs["ai"]["configuration"] | null,
) {
  if (!configuration || configuration.mode === "off") {
    return ["Off", "Enable when you want assistance"];
  }
  if (!configuration.configuration) {
    return ["Setup", "Connect your preferred model provider"];
  }
  if (configuration.configuration.useManagedModels) {
    return ["Subscriber", "Managed ZDR model with quota guardrails"];
  }
  return ["Connected", "Using your local AI configuration"];
}

/** Renders a compact AI usage or status control for the workspace header. */
export function AiUsageChip({
  deploymentMode,
  initialPlanUsage,
  initialConfiguration,
}: {
  deploymentMode: DeploymentMode;
  initialPlanUsage?: RouterOutputs["ai"]["planUsage"];
  initialConfiguration?: RouterOutputs["ai"]["configuration"];
}) {
  const localMode = deploymentMode === "local";
  const configuration = api.ai.configuration.useQuery(undefined, {
    enabled: localMode,
    initialData: initialConfiguration,
    refetchOnWindowFocus: true,
  });
  const planUsage = api.ai.planUsage.useQuery(undefined, {
    enabled: !localMode,
    initialData: initialPlanUsage ?? undefined,
    refetchOnWindowFocus: true,
  });
  const usage = planUsage.data ?? initialPlanUsage;
  const usagePercent = usage
    ? Math.min(100, (usage.usedTokens / usage.limitTokens) * 100)
    : 0;
  const resetLabel = usage?.resetsAt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
  const [localStatus, localDetail] = localAiLabel(configuration.data ?? null);
  const label = localMode
    ? localStatus
    : usage
      ? `${formatTokenCount(usage.usedTokens)}/${formatTokenCount(usage.limitTokens)}`
      : "AI";
  const detail = localMode
    ? localDetail
    : usage
      ? `${formatTokenCount(usage.remainingTokens)} left · resets ${resetLabel}`
      : "View AI usage and plans";
  const ariaLabel = localMode
    ? `AI assistant, ${localStatus}. ${localDetail}`
    : usage
      ? `AI usage, ${formatTokenCount(usage.usedTokens)} of ${formatTokenCount(usage.limitTokens)} tokens used, ${detail}`
      : "AI usage";

  return (
    <Link
      href="/settings/ai"
      title={detail}
      aria-label={ariaLabel}
      className="text-mist hover:text-cloud hover:bg-surface-hover grid size-10 place-items-center rounded-xl border border-line bg-surface/75 px-0 transition sm:flex sm:h-9 sm:w-auto sm:gap-2 sm:px-2.5 sm:text-xs"
    >
      <LinkNavigationStatus
        idle={
          <Sparkles
            className="text-violet size-3.5 shrink-0"
            aria-hidden="true"
          />
        }
        pending={
          <Spinner className="navigation-pending-reveal text-violet size-3.5" />
        }
      />
      <span className="hidden tabular-nums sm:inline">{label}</span>
      {!localMode && usage && (
        <span
          className="bg-surface-subtle hidden h-1 w-8 overflow-hidden rounded-full sm:block"
          role="progressbar"
          aria-label="Monthly AI token usage"
          aria-valuemin={0}
          aria-valuemax={usage.limitTokens}
          aria-valuenow={usage.usedTokens}
        >
          <span
            className={cn(
              "block h-full rounded-full",
              usagePercent >= 90 ? "bg-coral" : "bg-violet",
            )}
            style={{ width: `${usagePercent}%` }}
          />
        </span>
      )}
    </Link>
  );
}
