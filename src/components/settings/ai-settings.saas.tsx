"use client";

import { PricingTable, Show } from "@clerk/nextjs";
import { SubscriptionDetailsButton } from "@clerk/nextjs/experimental";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatTokenCount } from "~/lib/token-usage";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Configuration = RouterOutputs["ai"]["configuration"];
type PlanUsage = NonNullable<RouterOutputs["ai"]["planUsage"]>;
type AssistanceMode = Configuration["mode"];

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
}: {
  initialConfiguration: Configuration;
  initialPlanUsage: PlanUsage;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [mode, setMode] = useState(initialConfiguration.mode);
  const [reviewPullRequests, setReviewPullRequests] = useState(
    initialConfiguration.reviewPullRequests,
  );
  // Read from the configuration rather than from `planUsage.subscribed`, so
  // this page and the review workspace gate on exactly one predicate.
  const deepReviewAvailable = initialConfiguration.deepReviewAvailable;
  const planUsage = api.ai.planUsage.useQuery(undefined, {
    initialData: initialPlanUsage,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
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
  const dirty =
    mode !== initialConfiguration.mode ||
    reviewPullRequests !== initialConfiguration.reviewPullRequests;
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
            Your plan controls how many tokens you can use each month.
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

      <section aria-labelledby="ai-plan-usage-heading" className="mt-8">
        <h2 id="ai-plan-usage-heading" className="sr-only">
          Plan and token usage
        </h2>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
          <article className="bg-surface/70 min-w-0 rounded-2xl border border-line p-5 sm:p-6">
            <p className="text-mist text-xs font-medium tracking-wide uppercase">
              Monthly token usage
            </p>
            <div className="mt-4 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <p className="text-2xl font-semibold tracking-tight sm:text-3xl">
                <span className="tabular-nums">
                  {usage.usedTokens.toLocaleString("en-US")}
                </span>{" "}
                <span className="text-mist text-base font-normal">
                  / {planTokenLimit}
                </span>
              </p>
              <div className="min-w-0 flex-1 lg:max-w-xl">
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
          </article>

          <article className="bg-surface/70 flex min-w-0 flex-col rounded-2xl border border-line p-5 sm:p-6">
            <p className="text-mist text-xs font-medium tracking-wide uppercase">
              Current plan
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <p className="text-2xl font-semibold tracking-tight">
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
            <p className="text-fog mt-2 text-xs leading-5">
              {currentPlan.monthlyPrice
                ? `${planTokenLimit} managed AI tokens each month for $${currentPlan.monthlyPrice} USD.`
                : `${planTokenLimit} managed AI tokens included each month.`}
            </p>
          </article>
        </div>
      </section>

      <div
        className={cn(
          "mt-4 grid items-start gap-4",
          !usage.subscribed && "xl:grid-cols-[minmax(0,1fr)_22rem]",
        )}
      >
        <section
          aria-labelledby="ai-preferences-heading"
          className="bg-surface/70 overflow-hidden rounded-2xl border border-line"
        >
          <div className="border-b border-line px-5 py-5 sm:px-6">
            <h2 id="ai-preferences-heading" className="text-base font-medium">
              Assistant preferences
            </h2>
            <p className="text-mist mt-1 text-xs leading-5">
              Choose when ReviewDuck should spend tokens. The managed model and
              privacy controls are fixed by the SaaS deployment.
            </p>
          </div>

          <div className="divide-y divide-line">
            <div className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,16rem)] sm:items-center sm:gap-6 sm:px-6">
              <label htmlFor="ai-assistance-timing" className="min-w-0">
                <span className="text-cloud block text-sm font-medium">
                  Assistance timing
                </span>
                <span className="text-mist mt-1 block text-xs leading-5">
                  Off, on demand, or automatic explanations for each review
                  unit.
                </span>
              </label>
              <select
                id="ai-assistance-timing"
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as AssistanceMode)
                }
                className="bg-surface text-cloud focus:border-violet/40 h-11 w-full rounded-xl border border-line px-3 text-sm outline-none"
              >
                <option value="off">Off</option>
                <option value="on_demand">On demand</option>
                <option value="automatic">Automatic</option>
              </select>
            </div>

            <div
              className={cn(
                "grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6 sm:px-6",
                !deepReviewAvailable && "bg-surface-subtle/60",
              )}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-cloud text-sm font-medium">
                    Review the full pull request
                  </span>
                  {!deepReviewAvailable && (
                    <Badge className="border-violet/25 bg-violet/10 text-violet">
                      Pro
                    </Badge>
                  )}
                </p>
                <p className="text-mist mt-1 text-xs leading-5">
                  {deepReviewAvailable
                    ? "Request evidence-backed findings after a new revision syncs."
                    : "Pull-request review is a Pro capability. A full review fans out one agent per changed file, which the free monthly token allowance cannot fund."}
                </p>
              </div>
              <label className="inline-flex shrink-0 items-center gap-2 sm:mt-0.5">
                <span className="sr-only">Review the full pull request</span>
                <span className="relative inline-flex">
                  <input
                    type="checkbox"
                    checked={reviewPullRequests}
                    // Disabled rather than hidden: the preference persists across a
                    // downgrade, so a reader needs to see that it is on and why it is
                    // not running.
                    disabled={!deepReviewAvailable}
                    onChange={(event) =>
                      setReviewPullRequests(event.target.checked)
                    }
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="bg-surface-subtle peer-checked:bg-lime peer-focus-visible:ring-lime/55 peer-disabled:opacity-45 block h-6 w-10 rounded-full border border-line transition peer-checked:border-lime peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-ink peer-disabled:cursor-not-allowed"
                  />
                  <span
                    aria-hidden="true"
                    className="bg-cloud pointer-events-none absolute top-0.5 left-0.5 size-5 rounded-full shadow-sm transition peer-checked:translate-x-4 peer-checked:bg-accent-foreground peer-disabled:opacity-45"
                  />
                </span>
              </label>
            </div>
          </div>

          <div className="border-t border-line px-5 py-4 sm:flex sm:justify-end sm:px-6">
            <Button
              className="w-full sm:w-auto"
              variant={dirty ? "primary" : "secondary"}
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate({
                  provider: "openrouter",
                  model: initialConfiguration.managedModel,
                  clearApiKey: false,
                  clearHeaders: false,
                  headers: {},
                  useManagedModels: true,
                  mode,
                  reviewPullRequests,
                })
              }
            >
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              Save preferences
            </Button>
          </div>
        </section>

        {!usage.subscribed && (
          <section id="plans" className="scroll-mt-8">
            <div className="bg-surface/70 overflow-x-auto rounded-2xl border border-line p-5 sm:p-6">
              <h2 className="text-base font-medium">Plans</h2>
              <p className="text-mist mt-1 text-sm leading-6">
                Choose 20 million, 200 million, or 1 billion managed AI tokens
                per month. Plans start at $20 USD and can be managed here at any
                time.
              </p>
              <div className="mt-5">
                <PricingTable
                  for="user"
                  highlightedPlan="pro"
                  newSubscriptionRedirectUrl="/settings/ai"
                  fallback={
                    <div className="text-mist grid min-h-48 place-items-center text-sm">
                      Loading subscription options…
                    </div>
                  }
                />
              </div>
            </div>
          </section>
        )}
      </div>
    </PageContainer>
  );
}
