"use client";

import { LoaderCircle } from "lucide-react";
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
  const valid = Boolean(parsePullRequestLink(url));
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
    <main className="bg-ink text-cloud flex min-h-screen items-center justify-center p-6">
      <div className="border-line bg-panel w-full max-w-md rounded-xl border p-8">
        <div className="mb-4 flex items-center gap-3">
          {!error && (
            <LoaderCircle
              className="text-cyan size-5 animate-spin"
              aria-hidden="true"
            />
          )}
          <h1 className="text-lg font-semibold">
            {error ? "Could not open pull request" : "Preparing your review"}
          </h1>
        </div>
        {error ? (
          <p role="alert" className="text-fog text-sm">
            {error}
          </p>
        ) : (
          <div role="status" aria-live="polite">
            <p className="text-fog mb-4 text-sm">
              {target.data
                ? `${target.data.repositoryName} #${target.data.number}`
                : "Finding your connected repository…"}
            </p>
            {status.data && status.data.status !== "completed" ? (
              <SyncProgressMeter
                label="Pull request import"
                progress={status.data.progress}
                status={status.data.status}
              />
            ) : (
              <p className="text-fog text-sm">
                {status.data?.status === "completed"
                  ? "Opening review…"
                  : "Fetching and preparing pull request changes…"}
              </p>
            )}
          </div>
        )}
        <div className="mt-6 flex items-center gap-4">
          {error && valid && (
            <Button onClick={retry} disabled={isPending}>
              Try again
            </Button>
          )}
          <Link href="/pullrequests" className="text-cyan text-sm">
            Back to pull requests
          </Link>
          {target.error && (
            <Link href="/settings/providers" className="text-cyan text-sm">
              Manage repositories
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
