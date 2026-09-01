"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { parseOptionalReviewTokenCap } from "~/lib/token-usage";
import { cn } from "~/lib/utils";

type AssistanceMode = "off" | "on_demand" | "automatic";

/** Editable values shared by local and SaaS AI preference forms. */
interface AiPreferenceValues {
  mode: AssistanceMode;
  reviewPullRequests: boolean;
  maxReviewTokensInput: string;
}

interface InitialAiPreferences {
  mode: AssistanceMode;
  reviewPullRequests: boolean;
  maxReviewTokens: number | null;
}

type PreferencePersistence =
  | { kind: "with-provider"; pending: boolean }
  | {
      kind: "standalone";
      pending: boolean;
      dirty: boolean;
      onSave: () => void;
    };

/** Deployment-owned copy and entitlement presentation for the shared form. */
type AiPreferencesDeployment =
  | {
      kind: "local";
      introduction: string;
      deepReviewDescription: { available: string; unavailable: string };
      tokenCapDescription: string;
    }
  | {
      kind: "saas";
      introduction: string;
      deepReviewDescription: { available: string; unavailable: string };
      tokenCapDescription: string;
      unavailableBadge: string;
    };

/**
 * Owns the editable AI preference draft and its normalized token limit.
 * Consumers keep deployment-specific persistence payloads outside this hook.
 */
export function useAiPreferenceDraft(initial: InitialAiPreferences) {
  const [values, setValues] = useState<AiPreferenceValues>({
    mode: initial.mode,
    reviewPullRequests: initial.reviewPullRequests,
    maxReviewTokensInput: initial.maxReviewTokens?.toString() ?? "",
  });
  const maxReviewTokens = parseOptionalReviewTokenCap(
    values.maxReviewTokensInput,
  );
  const dirty =
    values.mode !== initial.mode ||
    values.reviewPullRequests !== initial.reviewPullRequests ||
    maxReviewTokens.cap !== initial.maxReviewTokens;

  return { values, setValues, maxReviewTokens, dirty };
}

/**
 * Renders the shared, controlled AI-assistance preferences for either
 * deployment. Provider and subscription controls remain in their page shells.
 */
export function AiPreferencesForm({
  values,
  onValuesChange,
  deepReviewAvailable,
  deployment,
  persistence,
}: {
  values: AiPreferenceValues;
  onValuesChange: (values: AiPreferenceValues) => void;
  deepReviewAvailable: boolean;
  deployment: AiPreferencesDeployment;
  persistence: PreferencePersistence;
}) {
  const maxReviewTokens = parseOptionalReviewTokenCap(
    values.maxReviewTokensInput,
  );
  const pending = persistence.pending;

  return (
    <section
      aria-labelledby="ai-preferences-heading"
      className={cn(
        "bg-surface/70 overflow-hidden rounded-2xl border border-line",
        deployment.kind === "saas" && "flex h-full flex-col",
      )}
    >
      <div className="border-b border-line px-5 py-5 sm:px-6">
        <h2 id="ai-preferences-heading" className="text-base font-medium">
          Assistant preferences
        </h2>
        <p className="text-mist mt-1 text-xs leading-5">
          {deployment.introduction}
        </p>
      </div>

      <div
        className={cn(
          "divide-y divide-line",
          deployment.kind === "saas" && "flex-1",
        )}
      >
        <div className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,16rem)] sm:items-center sm:gap-6 sm:px-6">
          <label htmlFor="ai-assistance-timing" className="min-w-0">
            <span className="text-cloud block text-sm font-medium">
              Assistance timing
            </span>
            <span className="text-mist mt-1 block text-xs leading-5">
              Off, on demand, or automatic explanations for each review unit.
            </span>
          </label>
          <select
            id="ai-assistance-timing"
            value={values.mode}
            disabled={pending}
            onChange={(event) =>
              onValuesChange({
                ...values,
                mode: event.target.value as AssistanceMode,
              })
            }
            className="bg-surface text-cloud focus:border-violet/40 h-11 w-full rounded-xl border border-line px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-45"
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
              {deployment.kind === "saas" && !deepReviewAvailable && (
                <Badge className="border-violet/25 bg-violet/10 text-violet">
                  {deployment.unavailableBadge}
                </Badge>
              )}
            </p>
            <p className="text-mist mt-1 text-xs leading-5">
              {deepReviewAvailable
                ? deployment.deepReviewDescription.available
                : deployment.deepReviewDescription.unavailable}
            </p>
          </div>
          <label className="inline-flex shrink-0 items-center gap-2 sm:mt-0.5">
            <span className="sr-only">Review the full pull request</span>
            <span className="relative inline-flex">
              <input
                type="checkbox"
                checked={values.reviewPullRequests}
                disabled={!deepReviewAvailable || pending}
                onChange={(event) =>
                  onValuesChange({
                    ...values,
                    reviewPullRequests: event.target.checked,
                  })
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

        <div className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,16rem)] sm:items-center sm:gap-6 sm:px-6">
          <label htmlFor="ai-review-token-cap" className="min-w-0">
            <span className="text-cloud block text-sm font-medium">
              Tokens per review
            </span>
            <span className="text-mist mt-1 block text-xs leading-5">
              {deployment.tokenCapDescription}
            </span>
          </label>
          <div className="min-w-0">
            <input
              id="ai-review-token-cap"
              inputMode="numeric"
              value={values.maxReviewTokensInput}
              placeholder="No limit"
              disabled={pending}
              onChange={(event) =>
                onValuesChange({
                  ...values,
                  maxReviewTokensInput: event.target.value,
                })
              }
              className="bg-surface text-cloud focus:border-violet/40 h-11 w-full rounded-xl border border-line px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-45"
            />
            {!maxReviewTokens.valid && (
              <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                Enter a whole number of tokens, or leave this empty.
              </p>
            )}
          </div>
        </div>
      </div>

      {persistence.kind === "standalone" && (
        <div className="border-t border-line px-5 py-4 sm:flex sm:justify-end sm:px-6">
          <Button
            className="w-full sm:w-auto"
            variant={persistence.dirty ? "primary" : "secondary"}
            disabled={!persistence.dirty || !maxReviewTokens.valid || pending}
            onClick={persistence.onSave}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save preferences
          </Button>
        </div>
      )}
    </section>
  );
}
