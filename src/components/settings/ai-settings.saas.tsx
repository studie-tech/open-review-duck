"use client";

import { PricingTable, Show } from "@clerk/nextjs";
import { SubscriptionDetailsButton } from "@clerk/nextjs/experimental";
import { ArrowUpRight, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import { formatTokenCount } from "~/lib/token-usage";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Configuration = RouterOutputs["ai"]["configuration"];
type PlanUsage = NonNullable<RouterOutputs["ai"]["planUsage"]>;

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
      <p className="text-violet text-xs font-semibold tracking-[.18em] uppercase">
        AI assistant
      </p>
      <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em]">
        Usage, preferences, and billing
      </h1>
      <p className="text-mist mt-2 max-w-2xl text-sm leading-6">
        ReviewDuck manages one privacy-protected model for every account. Your
        plan controls how many tokens you can use each month.
      </p>

      <section className="mt-9 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(16rem,.55fr)]">
        <article className="bg-surface/70 rounded-3xl border border-line p-6">
          <div className="flex items-start justify-between gap-5">
            <div>
              <p className="text-mist text-xs">Monthly token usage</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight">
                {usage.usedTokens.toLocaleString("en-US")}{" "}
                <span className="text-mist text-base font-normal">
                  / {planTokenLimit}
                </span>
              </p>
            </div>
            <span className="bg-violet/10 text-violet grid size-10 place-items-center rounded-xl">
              <Sparkles className="size-4" />
            </span>
          </div>
          <div
            className="bg-surface-subtle mt-6 h-2 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Monthly AI token usage"
            aria-valuemin={0}
            aria-valuemax={usage.limitTokens}
            aria-valuenow={usage.usedTokens}
          >
            <div
              className="bg-violet h-full rounded-full transition-[width]"
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <div className="text-fog mt-3 flex flex-wrap justify-between gap-2 text-xs">
            <span>{formatTokenCount(usage.remainingTokens)} tokens left</span>
            <span>
              Resets{" "}
              <time dateTime={usage.resetsAt.toISOString()}>{resetLabel}</time>
            </span>
          </div>
        </article>

        <article className="bg-surface/70 rounded-3xl border border-line p-6">
          <p className="text-mist text-xs">Current plan</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">
            {usage.subscribed ? "Pro" : "Free"}
          </p>
          <p className="text-fog mt-2 text-xs leading-5">
            {usage.subscribed
              ? `${planTokenLimit} managed AI tokens each month for $20 USD.`
              : `${planTokenLimit} managed AI tokens included each month.`}
          </p>
          {usage.subscribed ? (
            <Show when="signed-in">
              <SubscriptionDetailsButton for="user">
                <Button variant="secondary" className="mt-5 w-full">
                  Manage subscription <ArrowUpRight className="size-4" />
                </Button>
              </SubscriptionDetailsButton>
            </Show>
          ) : (
            <a
              href="#plans"
              className="text-violet mt-5 inline-flex items-center gap-1 text-sm font-medium hover:underline"
            >
              View Pro plan <ArrowUpRight className="size-4" />
            </a>
          )}
        </article>
      </section>

      <section className="bg-surface/70 mt-6 grid gap-5 rounded-3xl border border-line p-6">
        <div>
          <h2 className="text-lg font-medium">Assistant preferences</h2>
          <p className="text-mist mt-1 text-xs leading-5">
            Choose when ReviewDuck should spend tokens. The managed model and
            privacy controls are fixed by the SaaS deployment.
          </p>
        </div>
        <label
          htmlFor="ai-assistance-timing"
          className="text-mist grid gap-2 text-xs"
        >
          Assistance timing
          <select
            id="ai-assistance-timing"
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
            className="bg-surface text-cloud h-11 rounded-xl border border-line px-4 text-sm outline-none"
          >
            <option value="off">Off</option>
            <option value="on_demand">On demand</option>
            <option value="automatic">
              Automatically explain each review unit
            </option>
          </select>
        </label>
        <label
          className={cn(
            "bg-surface-subtle text-mist flex items-center justify-between gap-5 rounded-xl border border-line p-4 text-xs",
            !deepReviewAvailable && "opacity-60",
          )}
        >
          <span>
            <span className="text-cloud block text-sm font-medium">
              Review the full pull request
            </span>
            <span className="mt-1 block">
              {deepReviewAvailable
                ? "Request evidence-backed findings after a new revision syncs."
                : "Pull-request review is a Pro capability. A full review fans out one agent per changed file, which the free monthly token allowance cannot fund."}
            </span>
          </span>
          <input
            type="checkbox"
            checked={reviewPullRequests}
            // Disabled rather than hidden: the preference persists across a
            // downgrade, so a reader needs to see that it is on and why it is
            // not running.
            disabled={!deepReviewAvailable}
            onChange={(event) => setReviewPullRequests(event.target.checked)}
            className="accent-lime size-4"
          />
        </label>
        <div className="flex justify-end">
          <Button
            disabled={save.isPending}
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
        <section id="plans" className="mt-10 scroll-mt-8">
          <div className="mb-5">
            <p className="text-violet text-xs font-semibold tracking-[.18em] uppercase">
              Upgrade
            </p>
            <h2 className="font-editorial mt-2 text-3xl font-medium tracking-[-.035em]">
              More room for deeper reviews
            </h2>
            <p className="text-mist mt-2 max-w-2xl text-sm leading-6">
              Upgrade securely through Clerk for 5 million tokens every month.
              Cancel from this page at any time.
            </p>
          </div>
          <div className="bg-surface/55 overflow-hidden rounded-3xl border border-line p-3 sm:p-6">
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
        </section>
      )}
    </PageContainer>
  );
}
