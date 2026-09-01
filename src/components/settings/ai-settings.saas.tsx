"use client";

import { PricingTable, Show } from "@clerk/nextjs";
import { SubscriptionDetailsButton } from "@clerk/nextjs/experimental";
import { ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import {
  AiPreferencesForm,
  useAiPreferenceDraft,
} from "~/components/settings/ai-preferences-form";
import { AiPromptEditor } from "~/components/settings/ai-prompt-editor";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { hydratedQueryOptions } from "~/lib/hydration-clock";
import { formatTokenCount } from "~/lib/token-usage";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Configuration = RouterOutputs["ai"]["configuration"];
type PlanUsage = NonNullable<RouterOutputs["ai"]["planUsage"]>;

const saasPreferenceDeployment = {
  kind: "saas",
  introduction:
    "Choose when ReviewDuck should spend tokens. The managed model and privacy controls are fixed by the SaaS deployment.",
  deepReviewDescription: {
    available: "Request evidence-backed findings after a new revision syncs.",
    unavailable:
      "Pull-request review is a Pro capability. A full review fans out one agent per changed file, which the free monthly token allowance cannot fund.",
  },
  tokenCapDescription:
    "Optional cap on one review. Leave empty for no limit. New reviews cannot start after your monthly plan tokens are used up.",
  unavailableBadge: "Pro",
} as const;

const planDetails = {
  free: { name: "Free", monthlyPrice: null },
  pro: { name: "Pro", monthlyPrice: 20 },
  scale: { name: "Scale", monthlyPrice: 100 },
  ultra: { name: "Ultra", monthlyPrice: 200 },
} as const;

/** Renders SaaS AI preferences, monthly usage, and Clerk subscription controls. */
export function SaasAiSettings({
  initialConfiguration,
  initialPlanUsage,
  fetchedAt,
}: {
  initialConfiguration: Configuration;
  initialPlanUsage: PlanUsage;
  fetchedAt: number;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const preferences = useAiPreferenceDraft(initialConfiguration);
  // Read from the configuration rather than from `planUsage.subscribed`, so
  // this page and the review workspace gate on exactly one predicate.
  const deepReviewAvailable = initialConfiguration.deepReviewAvailable;
  const planUsage = api.ai.planUsage.useQuery(
    undefined,
    hydratedQueryOptions(initialPlanUsage, fetchedAt),
  );
  const usage = planUsage.data ?? initialPlanUsage;
  const currentPlan = planDetails[usage.tier];
  const usagePercent = Math.min(
    100,
    Math.round((usage.usedTokens / usage.limitTokens) * 100),
  );
  const resetLabel = usage.resetsAt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
  });
  const planTokenLimit = usage.limitTokens.toLocaleString("en-US");
  const save = api.ai.saveConfiguration.useMutation({
    onSuccess: () => {
      void Promise.all([
        utils.ai.configuration.invalidate(),
        utils.workspace.guidance.invalidate(),
      ]);
      router.refresh();
      toast.success("AI preferences saved");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <PageContainer>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="text-violet text-xs font-semibold tracking-[.18em] uppercase">
            AI assistant
          </p>
          <h1 className="font-editorial mt-2 text-3xl font-medium tracking-[-.04em] sm:text-4xl">
            Usage, preferences, and billing
          </h1>
          <p className="text-mist mt-2 max-w-2xl text-sm leading-6">
            ReviewDuck manages one privacy-protected model for every account.
            Your plan controls how many tokens you can use each month. A review
            that is already running can finish even if it crosses that monthly
            allowance.
          </p>
        </div>
        {usage.subscribed ? (
          <Show when="signed-in">
            <SubscriptionDetailsButton for="user">
              <Button variant="secondary" className="w-full sm:w-auto">
                Manage subscription <ArrowUpRight className="size-4" />
              </Button>
            </SubscriptionDetailsButton>
          </Show>
        ) : (
          <Button asChild variant="secondary" className="w-full sm:w-auto">
            <a href="#plans">
              View plans <ArrowUpRight className="size-4" />
            </a>
          </Button>
        )}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2 lg:items-stretch">
        <section
          aria-labelledby="ai-plan-usage-heading"
          className="bg-surface/70 flex h-full min-w-0 flex-col rounded-2xl border border-line p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2
                id="ai-plan-usage-heading"
                className="text-mist text-xs font-medium tracking-wide uppercase"
              >
                Monthly token usage
              </h2>
              <p className="text-fog mt-2 text-xs leading-5">
                {currentPlan.monthlyPrice
                  ? `${planTokenLimit} managed AI tokens each month for $${currentPlan.monthlyPrice} USD.`
                  : `${planTokenLimit} managed AI tokens included each month.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-semibold tracking-tight">
                {currentPlan.name}
              </p>
              <Badge
                className={
                  usage.subscribed
                    ? "border-violet/25 bg-violet/10 text-violet"
                    : undefined
                }
              >
                {usage.subscribed ? "Active" : "Current"}
              </Badge>
            </div>
          </div>
          <div className="mt-5 flex flex-1 flex-col justify-center gap-5">
            <p className="text-2xl font-semibold tracking-tight sm:text-3xl">
              <span className="tabular-nums">
                {usage.usedTokens.toLocaleString("en-US")}
              </span>{" "}
              <span className="text-mist text-base font-normal">
                / {planTokenLimit}
              </span>
            </p>
            <div className="min-w-0">
              <div
                className="bg-surface-subtle h-2 overflow-hidden rounded-full"
                role="progressbar"
                aria-label="Monthly AI token usage"
                aria-valuemin={0}
                aria-valuemax={usage.limitTokens}
                aria-valuenow={usage.usedTokens}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    usagePercent >= 90 ? "bg-lime" : "bg-violet",
                  )}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>
              <div className="text-fog mt-3 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs">
                <span>
                  {formatTokenCount(usage.remainingTokens)} tokens left
                </span>
                <span>
                  Resets{" "}
                  <time dateTime={usage.resetsAt.toISOString()}>
                    {resetLabel}
                  </time>
                </span>
              </div>
            </div>
          </div>
        </section>

        <AiPreferencesForm
          values={preferences.values}
          onValuesChange={preferences.setValues}
          deepReviewAvailable={deepReviewAvailable}
          deployment={saasPreferenceDeployment}
          persistence={{
            kind: "standalone",
            pending: save.isPending,
            dirty: preferences.dirty,
            onSave: () =>
              save.mutate({
                provider: "openrouter",
                model: initialConfiguration.managedModel,
                clearApiKey: false,
                clearHeaders: false,
                headers: {},
                useManagedModels: true,
                mode: preferences.values.mode,
                reviewPullRequests: preferences.values.reviewPullRequests,
                maxReviewTokens: preferences.maxReviewTokens.cap,
              }),
          }}
        />
      </div>

      {initialConfiguration.canEditPrompts && <AiPromptEditor />}

      {!usage.subscribed && (
        <section
          id="plans"
          aria-labelledby="ai-plans-heading"
          className="mt-4 scroll-mt-8"
        >
          <div className="bg-surface/70 overflow-hidden rounded-2xl border border-line">
            <div className="border-b border-line px-5 py-5 sm:px-6">
              <h2 id="ai-plans-heading" className="text-base font-medium">
                Plans
              </h2>
              <p className="text-mist mt-1 max-w-2xl text-sm leading-6">
                Choose 20 million, 200 million, or 1 billion managed AI tokens
                per month. Plans start at $20 USD and can be managed here at any
                time.
              </p>
            </div>
            <div className="p-5 sm:p-6">
              <div className="min-w-0 overflow-x-auto">
                <PricingTable
                  for="user"
                  highlightedPlan="pro"
                  newSubscriptionRedirectUrl="/settings/ai"
                  appearance={{
                    elements: {
                      rootBox: "w-full",
                      pricingTable:
                        "w-full grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]",
                    },
                  }}
                  fallback={
                    <div className="text-mist grid min-h-48 place-items-center text-sm">
                      Loading subscription options…
                    </div>
                  }
                />
              </div>
            </div>
          </div>
        </section>
      )}
    </PageContainer>
  );
}
