import { GitPullRequest, Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import { PullRequestList } from "~/components/dashboard/pull-request-list";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import { isLocalDeployment } from "~/server/deployment";
import { api } from "~/trpc/server";

/** Renders the dashboard page interface. */
export default async function DashboardPage() {
  const local = isLocalDeployment();
  const [pullRequests, aiConfiguration] = await Promise.all([
    api.review.dashboard(),
    api.ai.configuration(),
  ]);
  const carriedSignOffs = pullRequests.reduce(
    (total, pullRequest) => total + pullRequest.carriedSignOffs,
    0,
  );
  const aiStatus =
    aiConfiguration.mode === "off"
      ? ["Off", "Enable when you want assistance"]
      : !aiConfiguration.configuration
        ? [
            "Setup",
            local
              ? "Connect your preferred model provider"
              : "Choose managed or bring your own model",
          ]
        : aiConfiguration.configuration.useManagedModels
          ? ["Pro", "Managed model with quota guardrails"]
          : ["BYOK", "Using your encrypted provider key"];

  return (
    <PageContainer>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
            Review queue
          </p>
          <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em] sm:text-5xl">
            Good code deserves attention.
          </h1>
          <p className="text-mist mt-3 max-w-xl text-sm leading-6">
            Continue from your last sign-off or pick up a fresh change. The
            dependency path is already prepared.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/providers">
            <Plus className="size-4" /> Add repository
          </Link>
        </Button>
      </div>

      <section className="mt-10 grid gap-4 sm:grid-cols-3">
        {[
          [
            "Open reviews",
            String(pullRequests.length),
            "Across connected repositories",
          ],
          [
            "Focus saved",
            String(carriedSignOffs),
            "Sign-offs safely reused on current revisions",
          ],
          ["AI assistant", aiStatus[0], aiStatus[1]],
        ].map(([label, value, detail], index) => (
          <article
            key={label}
            className="bg-surface rounded-2xl border border-line p-5 shadow-[0_14px_40px_var(--app-shadow)]"
          >
            <div className="flex items-center justify-between">
              <p className="text-mist text-xs">{label}</p>
              {index === 2 && <Sparkles className="text-violet size-3.5" />}
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight">
              {value}
            </p>
            <p className="text-fog mt-1 text-[11px]">{detail}</p>
          </article>
        ))}
      </section>

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium">Needs your review</h2>
          <span className="text-fog text-xs">
            {pullRequests.length} pull requests
          </span>
        </div>
        {pullRequests.length === 0 ? (
          <div className="bg-surface/55 grid min-h-80 place-items-center rounded-3xl border border-dashed border-line-strong p-8 text-center">
            <div>
              <span className="text-lime mx-auto grid size-12 place-items-center rounded-2xl bg-lime/10">
                <GitPullRequest className="size-5" />
              </span>
              <h3 className="mt-5 text-lg font-medium">
                Connect your first repository
              </h3>
              <p className="text-mist mx-auto mt-2 max-w-sm text-sm leading-6">
                Add GitHub, GitLab, or Azure DevOps and choose the pull requests
                you want to review with full context.
              </p>
              <Button asChild className="mt-6">
                <Link href="/settings/providers">Connect a provider</Link>
              </Button>
            </div>
          </div>
        ) : (
          <PullRequestList pullRequests={pullRequests} />
        )}
      </section>
    </PageContainer>
  );
}
