"use client";

import {
  AlertCircle,
  ArrowLeft,
  Check,
  GitPullRequest,
  LoaderCircle,
  Settings2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { parsePullRequestLink } from "~/lib/pull-request-link";
import { api } from "~/trpc/react";
import { SyncProgressMeter } from "./sync-progress-meter";

/** Imports a linked PR, follows its durable job, and opens the prepared review. */
export function PullRequestImport({ url }: { url: string }) {
  const router = useRouter();
  const link = parsePullRequestLink(url);
  const valid = Boolean(link);
  const target = api.review.resolveImportLink.useQuery(
    { url },
    { enabled: valid, retry: false },
  );
  const [syncId, setSyncId] = useState<string>();
  const started = useRef(false);
  const {
    mutate,
    error: importError,
    isPending,
  } = api.review.sync.useMutation({
    onSuccess: (result) => setSyncId(result.syncId),
  });
  const status = api.review.syncStatus.useQuery(
    { syncId: syncId ?? "00000000-0000-4000-8000-000000000000" },
    {
      enabled: Boolean(syncId),
      refetchInterval: (query) =>
        ["completed", "failed", "cancelled"].includes(
          query.state.data?.status ?? "",
        )
          ? false
          : 1_500,
      retry: false,
    },
  );

  useEffect(() => {
    if (!target.data || started.current) return;
    started.current = true;
    mutate({
      repositoryId: target.data.repositoryId,
      number: target.data.number,
    });
  }, [target.data, mutate]);

  useEffect(() => {
    if (status.data?.status === "completed" && status.data.pullRequestId) {
      router.replace(`/review/${status.data.pullRequestId}`);
    }
  }, [status.data, router]);

  const terminalFailure = ["failed", "cancelled"].includes(
    status.data?.status ?? "",
  );
  const error = !valid
    ? "Use a link with a valid GitHub pull request, GitLab merge request, or Azure DevOps pull request URL."
    : (target.error?.message ??
      importError?.message ??
      status.error?.message ??
      (terminalFailure
        ? (status.data?.error ??
          "Pull request import was interrupted. Please try again.")
        : undefined) ??
      (status.data?.status === "completed" && !status.data.pullRequestId
        ? "The imported pull request could not be found."
        : undefined));

  const missingRepository = target.error?.data?.code === "NOT_FOUND";
  const ambiguousRepository = target.error?.data?.code === "CONFLICT";
  const invalidLink = !valid || target.error?.data?.code === "BAD_REQUEST";
  const canRetry =
    Boolean(error) &&
    !missingRepository &&
    !ambiguousRepository &&
    !invalidLink;
  const retryPending = isPending || target.isFetching || status.isFetching;
  const complete = status.data?.status === "completed";
  const repositoryName =
    target.data?.repositoryName ??
    (link ? new URL(link.repositoryUrl).pathname.slice(1) : undefined);
  const number = target.data?.number ?? link?.number;
  const title = missingRepository
    ? "Connect this repository"
    : ambiguousRepository
      ? "Choose a repository connection"
      : invalidLink
        ? "This link needs a pull request"
        : error
          ? "Could not prepare your review"
          : complete
            ? "Your review is ready"
            : "Preparing your review";
  const steps = [
    { label: "Find repository", done: Boolean(target.data) },
    { label: "Prepare changes", done: complete },
    { label: "Open review", done: false },
  ];
  const activeStep = complete ? 2 : target.data ? 1 : 0;

  /** Retries a failed lookup, status request, or durable import. */
  function retry() {
    if (target.error) {
      void target.refetch();
      return;
    }
    if (status.error) {
      void status.refetch();
      return;
    }
    if (target.data) {
      setSyncId(undefined);
      mutate({
        repositoryId: target.data.repositoryId,
        number: target.data.number,
      });
    }
  }

  return (
    <main className="bg-ink text-cloud flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-lg">
        <div className="text-fog mb-6 flex items-center justify-center gap-2 text-sm font-semibold">
          <GitPullRequest className="text-cyan size-4" aria-hidden="true" />
          ReviewDuck
        </div>
        <section
          aria-labelledby="import-title"
          className="border-line bg-panel overflow-hidden rounded-2xl border shadow-[0_24px_80px_var(--app-shadow)]"
        >
          <div className="p-6 sm:p-8">
            <div
              className={`mb-5 flex size-12 items-center justify-center rounded-xl ${error ? "bg-surface-subtle text-mist" : "bg-cyan/10 text-cyan"}`}
            >
              {error ? (
                <AlertCircle className="size-6" aria-hidden="true" />
              ) : complete ? (
                <Check className="size-6" aria-hidden="true" />
              ) : (
                <LoaderCircle
                  className="size-6 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
            </div>
            <h1
              id="import-title"
              className="text-xl font-semibold tracking-tight sm:text-2xl"
            >
              {title}
            </h1>
            {repositoryName && (
              <div className="border-line bg-surface mt-4 flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
                <GitPullRequest
                  className="text-fog size-4 shrink-0"
                  aria-hidden="true"
                />
                <span className="min-w-0 break-all font-medium">
                  {repositoryName}
                </span>
                <span className="text-fog ml-auto shrink-0">#{number}</span>
              </div>
            )}
            {error ? (
              <p
                role="alert"
                className="text-mist mt-4 text-sm leading-relaxed"
              >
                {error}
              </p>
            ) : (
              <div role="status" aria-live="polite" className="mt-4">
                <p className="text-mist text-sm leading-relaxed">
                  {complete
                    ? "Opening your pull request review…"
                    : "Your review will open automatically when it’s ready."}
                </p>
                <ol aria-label="Import steps" className="mt-6 space-y-3">
                  {steps.map((step, index) => (
                    <li
                      key={step.label}
                      aria-current={index === activeStep ? "step" : undefined}
                      className={`flex items-center gap-3 text-sm ${index <= activeStep ? "text-cloud" : "text-fog"}`}
                    >
                      <span
                        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${step.done ? "bg-cyan/10 text-cyan" : index === activeStep ? "border border-cyan/50 text-cyan" : "border border-line text-fog"}`}
                      >
                        {step.done ? (
                          <Check className="size-3.5" aria-hidden="true" />
                        ) : (
                          index + 1
                        )}
                      </span>
                      {step.label}
                    </li>
                  ))}
                </ol>
                {status.data && !complete && (
                  <div className="mt-6">
                    <SyncProgressMeter
                      label="Pull request import"
                      progress={status.data.progress}
                      status={status.data.status}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="border-line bg-surface/40 border-t p-6 sm:px-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              {(missingRepository || ambiguousRepository) && (
                <Button asChild className="w-full sm:flex-1">
                  <Link href="/settings/providers">
                    <Settings2 className="size-4" aria-hidden="true" />
                    Manage repositories
                  </Link>
                </Button>
              )}
              {canRetry && (
                <Button
                  onClick={retry}
                  loading={retryPending}
                  className="w-full sm:flex-1"
                >
                  Try again
                </Button>
              )}
              <Button asChild variant="secondary" className="w-full sm:flex-1">
                <Link href="/pullrequests">
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Back to pull requests
                </Link>
              </Button>
            </div>
            {syncId && !error && !complete && (
              <p className="text-fog mt-3 text-center text-xs leading-relaxed">
                You can leave this page. Preparation will continue in the
                background.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
