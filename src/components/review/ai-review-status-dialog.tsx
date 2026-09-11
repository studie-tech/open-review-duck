"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { modalSurfaceClassName } from "~/components/ui/modal-surface";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { AiReviewConfirmationDialog } from "./ai-review-confirmation-dialog";
import { aiJobActive } from "./review-workspace-hooks";
import { useStartPullRequestAiReview } from "./use-start-pull-request-ai-review";

/** Names persisted review states consistently in the inbox and workspace. */
export function aiReviewStatusLabel(
  run?: { status: string; deepReviewTerminalState?: string | null } | null,
) {
  if (!run) return "Review with AI";
  if (aiJobActive(run.status))
    return run.status === "queued" ? "AI review queued" : "AI reviewing…";
  if (run.status === "failed" || run.deepReviewTerminalState === "failed")
    return "AI review failed";
  if (run.status === "cancelled") return "AI review cancelled";
  if (run.deepReviewTerminalState === "partial") return "AI review partial";
  if (run.deepReviewTerminalState === "skipped") return "AI review skipped";
  return "AI review results";
}

/** Opens persisted progress and previous results without starting another run. */
export function AiReviewStatusDialog({
  pullRequestId,
  onClose,
  startDisabled = false,
}: {
  pullRequestId: string;
  onClose: () => void;
  startDisabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [selectedId, setSelectedId] = useState<string>();
  const [confirmStart, setConfirmStart] = useState(false);
  const status = api.ai.reviewStatus.useQuery(
    { pullRequestId },
    { refetchInterval: 2_000 },
  );
  const history = api.ai.reviewHistory.useQuery(
    { pullRequestId },
    { refetchInterval: 4_000 },
  );
  const jobId = selectedId ?? status.data?.id;
  const run = api.ai.reviewRun.useQuery(
    { jobId: jobId ?? "" },
    {
      enabled: Boolean(jobId),
      refetchInterval: (query) =>
        aiJobActive(query.state.data?.status) ? 2_000 : false,
    },
  );
  const start = useStartPullRequestAiReview({
    onSuccess: () => {
      setSelectedId(undefined);
      setConfirmStart(false);
    },
  });
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    return () => {
      element?.close?.();
      previousFocus?.focus();
    };
  }, []);
  const active = aiJobActive(status.data?.status) || start.isPending;
  const data = run.data;
  const reviewed = data ? data.coverage.completed + data.coverage.reused : 0;
  const settled = data
    ? reviewed + data.coverage.failed + data.coverage.waived
    : 0;
  const loading = status.isLoading || history.isLoading;
  const failed = status.isError || history.isError;
  return (
    <>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className={cn(
          modalSurfaceClassName,
          "z-[70] items-center justify-center p-4 backdrop:bg-black/65 backdrop:backdrop-blur-sm",
        )}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <div className="bg-panel flex max-h-[85dvh] w-full max-w-xl flex-col rounded-2xl border border-line-strong p-6 shadow-2xl">
          <div className="flex items-center justify-between gap-4">
            <h2
              id={titleId}
              className="text-cloud flex items-center gap-2 text-base font-semibold"
            >
              <Sparkles className="text-violet size-4" /> AI review
            </h2>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
          <div className="mt-4 min-h-0 space-y-4 overflow-y-auto text-sm">
            {loading ? (
              <p role="status">Loading review status…</p>
            ) : failed ? (
              <p role="alert">
                Could not load review status.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    void status.refetch();
                    void history.refetch();
                  }}
                >
                  Try again
                </button>
              </p>
            ) : !status.data ? (
              <p className="text-mist">
                No AI review has been started for this pull request. Start one
                to inspect the changed files and save evidence-backed findings
                here. This uses your configured model and contributes to this
                pull request’s token usage.
              </p>
            ) : (
              <>
                <div
                  className="bg-surface-subtle rounded-xl border border-line p-4"
                  role="status"
                >
                  <p className="text-cloud flex items-center gap-2 font-medium">
                    {active && (
                      <LoaderCircle className="text-violet size-4 animate-spin" />
                    )}
                    {aiReviewStatusLabel(status.data)}
                  </p>
                  <p className="text-mist mt-1">
                    {active
                      ? "You can close this dialog or leave this page. Your review will keep running, and its results will be saved here."
                      : "Your review is saved. Open its findings below or choose an earlier run."}
                  </p>
                </div>
                {history.data && history.data.length > 0 && (
                  <label className="text-mist block">
                    Review run
                    <select
                      className="bg-panel text-cloud mt-1 w-full rounded-lg border border-line p-2"
                      value={jobId ?? ""}
                      onChange={(event) => setSelectedId(event.target.value)}
                    >
                      {history.data.map((job) => (
                        <option key={job.id} value={job.id}>
                          {new Date(job.createdAt).toLocaleString()} ·{" "}
                          {aiReviewStatusLabel(job)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {run.isLoading ? (
                  <p>Loading findings…</p>
                ) : run.isError ? (
                  <p role="alert">
                    Could not load this run.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void run.refetch()}
                    >
                      Try again
                    </button>
                  </p>
                ) : (
                  data && (
                    <>
                      <div className="text-mist space-y-2">
                        <p className="text-cloud font-medium">
                          {aiReviewStatusLabel({
                            status: data.status,
                            deepReviewTerminalState: data.terminalState,
                          })}
                        </p>
                        <p>
                          Started {new Date(data.createdAt).toLocaleString()}
                          {data.completedAt
                            ? ` · Finished ${new Date(data.completedAt).toLocaleString()}`
                            : ""}
                        </p>
                        {data.coverage.total > 0 ? (
                          <>
                            <progress
                              aria-label="Review plan progress"
                              className="accent-violet h-2 w-full"
                              value={settled}
                              max={data.coverage.total}
                            />
                            <p>
                              {reviewed} of {data.coverage.total} review tasks
                              reviewed · {data.coverage.waived} skipped ·{" "}
                              {data.coverage.failed} failed
                            </p>
                          </>
                        ) : (
                          <p>
                            {aiJobActive(data.status)
                              ? "Preparing the review plan…"
                              : "No review tasks were completed."}
                          </p>
                        )}
                        {data.error && (
                          <p role="alert" className="text-coral">
                            {data.error}
                          </p>
                        )}
                        <p>
                          {data.isCurrentSnapshot
                            ? "Current revision"
                            : "Earlier revision"}
                          {data.headSha ? ` · ${data.headSha.slice(0, 8)}` : ""}{" "}
                          · {data.totalTokens?.toLocaleString() ?? 0} tokens
                          recorded
                        </p>
                        {!data.isCurrentSnapshot && (
                          <p>
                            This run reviewed an earlier snapshot. Its findings
                            may no longer apply to the current code.
                          </p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-cloud font-medium">
                          Findings ({data.findings.length})
                        </h3>
                        {data.findings.length === 0 && (
                          <p className="text-mist">
                            {aiJobActive(data.status)
                              ? "Findings will appear as analysis completes."
                              : "This run produced no findings. Check coverage above for any skipped or failed work."}
                          </p>
                        )}
                        {data.findings.map((finding) => (
                          <details
                            key={finding.id}
                            className="rounded-lg border border-line p-3"
                          >
                            <summary className="text-cloud cursor-pointer">
                              {finding.title || "Finding content unavailable"}{" "}
                              <span className="text-fog text-xs">
                                {finding.severity} · {finding.state}
                              </span>
                            </summary>
                            <p className="text-fog mt-2 break-all text-xs">
                              {finding.path}
                              {finding.startLine ? `:${finding.startLine}` : ""}
                            </p>
                            <p className="text-mist mt-2 whitespace-pre-wrap">
                              {finding.body}
                            </p>
                          </details>
                        ))}
                      </div>
                    </>
                  )
                )}
              </>
            )}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            <Link
              href={`/review/${pullRequestId}`}
              className="text-mist mr-auto text-sm underline"
              onClick={onClose}
            >
              Open pull request
            </Link>
            <Button
              variant="secondary"
              disabled={active || loading || failed || startDisabled}
              onClick={() => {
                if (status.data) setConfirmStart(true);
                else start.mutate({ pullRequestId, kind: "review" });
              }}
            >
              {active
                ? "Review in progress"
                : status.data
                  ? "Start another review…"
                  : "Start AI review"}
            </Button>
          </div>
        </div>
      </dialog>
      {confirmStart && (
        <AiReviewConfirmationDialog
          pending={start.isPending}
          onCancel={() => setConfirmStart(false)}
          onConfirm={() => {
            if (!active) start.mutate({ pullRequestId, kind: "review" });
          }}
        />
      )}
    </>
  );
}
