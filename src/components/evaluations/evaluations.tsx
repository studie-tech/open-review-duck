"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  FlaskConical,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { type EvalCase, evalCaseSchema } from "~/lib/evaluations";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

const field =
  "min-w-0 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-cloud outline-none focus:border-lime focus:ring-1 focus:ring-lime";
const panel = "min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5";
const emptyCase: EvalCase = {
  title: "",
  path: "",
  source: "",
  previousSource: "",
  finding: "",
  existingCode: "",
  label: "unlabeled",
  rationale: "",
  split: "development",
};
const labels = {
  bug: "Real bug",
  false_positive: "False positive",
  unlabeled: "Needs labeling",
};
type Run = RouterOutputs["evaluations"]["run"];

/** Displays a truth label consistently across dataset and run views. */
function Label({ value }: { value: EvalCase["label"] }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2.5 py-1 text-xs",
        value === "bug"
          ? "border-cyan/30 bg-cyan/10 text-cyan"
          : value === "false_positive"
            ? "border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-200"
            : "border-line text-mist",
      )}
    >
      {labels[value]}
    </span>
  );
}

/** Renders dataset selection, curation and isolated prompt experiments. */
export function Evaluations({ findingId }: { findingId?: string }) {
  const utils = api.useUtils();
  const datasets = api.evaluations.list.useQuery();
  const [datasetId, setDatasetId] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [captureSaved, setCaptureSaved] = useState(false);
  const [tab, setTab] = useState<"cases" | "experiment">("cases");
  const [editor, setEditor] = useState<(EvalCase & { id?: string }) | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [runId, setRunId] = useState("");
  const capture = api.evaluations.finding.useQuery(
    { findingId: findingId ?? "" },
    { enabled: Boolean(findingId), retry: false },
  );
  const selectedId = datasetId || datasets.data?.[0]?.id || "";
  const detail = api.evaluations.detail.useQuery(
    { datasetId: selectedId },
    { enabled: Boolean(selectedId) },
  );
  const create = api.evaluations.create.useMutation({
    onSuccess: async (row) => {
      await utils.evaluations.list.invalidate();
      setDatasetId(row.id);
      setCreating(false);
      setName("");
      if (capture.data) setEditor(capture.data);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = api.evaluations.deleteCase.useMutation({
    onSuccess: () => {
      void detail.refetch();
      toast.success("Case removed. Past runs retain their snapshots.");
    },
    onError: (e) => toast.error(e.message),
  });
  const cases = detail.data?.cases ?? [];
  const visible = cases.filter(
    (row) =>
      (filter === "all" || row.label === filter) &&
      `${row.title} ${row.path}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <main className="mx-auto min-w-0 w-full max-w-7xl space-y-4 px-4 py-5 sm:space-y-5 sm:px-6 sm:py-7 lg:px-9">
      <header className="relative">
        <div className="flex items-center gap-2.5">
          <FlaskConical
            className="text-lime size-5 shrink-0"
            aria-hidden="true"
          />
          <h1 className="text-cloud text-xl font-semibold tracking-tight sm:text-2xl">
            Reviewer lab
          </h1>
        </div>
        <p className="text-mist mt-1.5 text-sm">
          Build datasets, test prompts, compare results.
        </p>
        <details className="absolute right-0 top-0 text-xs text-mist">
          <summary className="cursor-pointer py-2 text-cyan">
            <span className="sm:hidden">Guide</span>
            <span className="hidden sm:inline">How it works</span>
          </summary>
          <div className="absolute right-0 z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl border border-line bg-surface p-4 leading-5 shadow-lg sm:w-80">
            <p>
              <strong className="text-cloud">1. Capture & label.</strong> Save
              findings and missed bugs with frozen code.
            </p>
            <p>
              <strong className="text-cloud">2. Test a prompt.</strong> Run
              experiments without changing live reviews.
            </p>
            <p>
              <strong className="text-cloud">3. Compare results.</strong>{" "}
              Inspect errors and validate on holdout cases.
            </p>
          </div>
        </details>
      </header>
      {(creating || datasets.data?.length === 0) && (
        <form
          className={cn(panel, "flex flex-wrap items-end gap-3")}
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name });
          }}
        >
          <label className="min-w-0 basis-full text-sm text-mist sm:flex-1">
            Dataset name
            <input
              className={cn(field, "mt-2")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. TypeScript correctness"
              required
              maxLength={120}
            />
          </label>
          <Button loading={create.isPending} type="submit">
            Create dataset
          </Button>
        </form>
      )}
      {datasets.error && (
        <p role="alert" className="text-red-500">
          {datasets.error.message}
        </p>
      )}
      {capture.error && (
        <p role="alert" className="text-red-500">
          {capture.error.message}
        </p>
      )}
      {capture.data && selectedId && !editor && !captureSaved && (
        <div
          className={cn(
            panel,
            "flex flex-wrap items-center justify-between gap-3 border-cyan/30",
          )}
        >
          <div>
            <p className="text-cloud font-medium">
              Ready to capture: {capture.data.title}
            </p>
            <p className="text-mist mt-1 text-sm">
              Review the frozen context and add a human label.
            </p>
          </div>
          <Button
            onClick={() => {
              setTab("cases");
              setEditor(capture.data);
            }}
          >
            Add finding to dataset
          </Button>
        </div>
      )}
      {selectedId && (
        <>
          <div className="space-y-3">
            <div className="flex min-w-0 items-center gap-2">
              <label className="min-w-0 flex-1 sm:max-w-md">
                <span className="sr-only">Dataset</span>
                <select
                  aria-label="Dataset"
                  className={field}
                  value={selectedId}
                  onChange={(e) => {
                    setDatasetId(e.target.value);
                    setEditor(null);
                    setRunId("");
                  }}
                >
                  {datasets.data?.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="secondary"
                aria-label="New dataset"
                title="New dataset"
                className="size-11 shrink-0 px-0 sm:w-auto sm:px-4"
                onClick={() => setCreating(!creating)}
              >
                <Plus className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">New dataset</span>
              </Button>
            </div>
            <div className="flex border-b border-line">
              {(["cases", "experiment"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={tab === value}
                  onClick={() => {
                    setTab(value);
                    if (value === "experiment") setEditor(null);
                  }}
                  className={cn(
                    "flex min-h-11 flex-1 items-center justify-center gap-2 border-b-2 px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime sm:flex-none",
                    tab === value
                      ? "border-lime text-cloud"
                      : "border-transparent text-mist hover:text-cloud",
                  )}
                >
                  {value === "cases" ? "Cases" : "Experiments"}
                  <span className="rounded-md bg-surface-subtle px-1.5 py-0.5 text-xs text-fog">
                    {value === "cases"
                      ? cases.length
                      : (detail.data?.runs.length ?? 0)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          {detail.isLoading && (
            <p className="text-mist" role="status">
              Loading dataset…
            </p>
          )}
          {detail.error && (
            <p role="alert" className="text-red-500">
              {detail.error.message}
            </p>
          )}
          {tab === "cases" &&
            (editor ? (
              <CaseEditor
                key={editor.id ?? editor.sourceFindingId ?? "new"}
                datasetId={selectedId}
                initial={editor}
                onClose={() => setEditor(null)}
                onSaved={() => {
                  if (editor.sourceFindingId) setCaptureSaved(true);
                  setEditor(null);
                  void detail.refetch();
                }}
              />
            ) : (
              <section className={panel}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
                  <h2 className="text-cloud text-base font-semibold sm:text-lg">
                    Your ground truth
                  </h2>
                  <Button size="sm" onClick={() => setEditor(emptyCase)}>
                    <Plus className="hidden size-4 min-[360px]:block" />
                    Add case
                  </Button>
                  <p className="text-mist col-span-2 text-xs leading-5 sm:text-sm">
                    {cases.filter((row) => row.label === "bug").length} real
                    bugs ·{" "}
                    {
                      cases.filter((row) => row.label === "false_positive")
                        .length
                    }{" "}
                    false positives ·{" "}
                    {cases.filter((row) => row.label === "unlabeled").length}{" "}
                    need labeling
                  </p>
                </div>
                <div className="my-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <div className="relative min-w-0">
                    <Search className="text-fog absolute top-3 left-3 size-4" />
                    <input
                      className={cn(field, "pl-9")}
                      placeholder="Search"
                      aria-label="Search cases"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <select
                    className={cn(field, "w-32 sm:w-40")}
                    aria-label="Filter labels"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All labels</option>
                    {Object.entries(labels).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </div>
                {visible.length ? (
                  <div className="divide-line divide-y">
                    {visible.map((row) => (
                      <div
                        key={row.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:py-4"
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setEditor(row)}
                        >
                          <span className="text-cloud block text-sm font-medium leading-5 [overflow-wrap:anywhere] hover:underline">
                            {row.title}
                          </span>
                          <span className="text-fog mt-1 block truncate font-mono text-xs">
                            {row.path}
                          </span>
                        </button>
                        <span className="text-fog hidden text-xs sm:block">
                          {row.split === "holdout" ? "Holdout" : "Development"}
                        </span>
                        <div className="col-start-1 row-start-2 flex items-center gap-2 sm:col-auto sm:row-auto">
                          <Label value={row.label} />
                          <span className="text-fog text-xs sm:hidden">
                            {row.split === "holdout"
                              ? "Holdout"
                              : "Development"}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="col-start-2 row-start-1 self-start sm:col-auto sm:row-auto sm:self-center"
                          aria-label={`Delete ${row.title}`}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove “${row.title}” from this dataset? Past runs will keep their captured copy.`,
                              )
                            )
                              remove.mutate({
                                datasetId: selectedId,
                                id: row.id,
                              });
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-12 text-center">
                    <FlaskConical className="text-fog mx-auto mb-4 size-8" />
                    <h3 className="text-cloud font-medium">
                      {cases.length
                        ? "No cases match this filter"
                        : "Start with a finding you disagree with"}
                    </h3>
                    <p className="text-mist mx-auto mt-2 max-w-lg text-sm leading-6">
                      Use “Save to evals” on a review finding, or add a case
                      here. Include missed bugs as real bugs to measure recall,
                      and reserve some examples for holdout testing.
                    </p>
                  </div>
                )}
                <p className="text-fog mt-4 border-t border-line pt-4 text-xs leading-5">
                  Labels are human judgments, never inferred from the reviewer’s
                  verdict. Unlabeled cases are excluded from runs. Source code
                  is encrypted at rest.
                </p>
              </section>
            ))}
          {tab === "experiment" && (
            <Experiment
              key={selectedId}
              datasetId={selectedId}
              cases={cases}
              runs={detail.data?.runs ?? []}
              runId={runId}
              setRunId={setRunId}
              onStarted={() => void detail.refetch()}
            />
          )}
        </>
      )}
    </main>
  );
}

/** Edits one human annotation and its reproducible, bounded source context. */
function CaseEditor({
  datasetId,
  initial,
  onClose,
  onSaved,
}: {
  datasetId: string;
  initial: EvalCase & { id?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const save = api.evaluations.saveCase.useMutation({
    onSuccess: () => {
      toast.success("Evaluation case saved");
      onSaved();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <form
      className={cn(panel, "space-y-5")}
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = evalCaseSchema.safeParse(draft);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Check the case fields");
          return;
        }
        save.mutate({ datasetId, id: initial.id, example: parsed.data });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-cloud text-lg font-semibold">
          {initial.id ? "Edit case" : "Add evaluation case"}
        </h2>
        <Button variant="ghost" type="button" onClick={onClose}>
          <ArrowLeft className="size-4" />
          Back to cases
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-mist text-sm">
          Case title
          <input
            required
            maxLength={180}
            className={cn(field, "mt-2")}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Null user causes a crash"
          />
        </label>
        <label className="text-mist text-sm">
          File path
          <input
            required
            className={cn(field, "mt-2")}
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            placeholder="src/auth/session.ts"
          />
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-mist text-sm">
          Ground-truth label
          <select
            className={cn(field, "mt-2")}
            value={draft.label}
            onChange={(e) =>
              setDraft({ ...draft, label: e.target.value as EvalCase["label"] })
            }
          >
            {Object.entries(labels).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label className="text-mist text-sm">
          Dataset split
          <select
            className={cn(field, "mt-2")}
            value={draft.split}
            onChange={(e) =>
              setDraft({ ...draft, split: e.target.value as EvalCase["split"] })
            }
          >
            <option value="development">Development — tune prompts here</option>
            <option value="holdout">
              Holdout — check generalization later
            </option>
          </select>
        </label>
      </div>
      <label className="text-mist block text-sm">
        Finding or missed bug
        <textarea
          required
          className={cn(field, "mt-2 min-h-24")}
          value={draft.finding}
          onChange={(e) => setDraft({ ...draft, finding: e.target.value })}
          placeholder="Describe the specific issue the reviewer should report or reject."
        />
      </label>
      <label className="text-mist block text-sm">
        Why is this label correct?
        <textarea
          className={cn(field, "mt-2 min-h-20")}
          value={draft.rationale}
          onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
          placeholder="Explain the behavior, invariant or test that establishes ground truth."
        />
      </label>
      <label className="text-mist block text-sm">
        Frozen source code
        <textarea
          required
          spellCheck={false}
          className={cn(field, "mt-2 min-h-56 font-mono text-xs")}
          value={draft.source}
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
        />
      </label>
      <p className="text-fog text-xs leading-5">
        Capture enough context to decide this issue. Discovery reviews this
        entire file, without seeing the label, title, rationale or expected
        finding. It cannot inspect the rest of the repository.
      </p>
      <details className="text-mist text-sm">
        <summary className="cursor-pointer">
          Verification context: quoted code and previous source
        </summary>
        <label className="mt-4 block">
          Quoted code
          <textarea
            className={cn(field, "mt-2 min-h-20 font-mono text-xs")}
            value={draft.existingCode}
            onChange={(e) =>
              setDraft({ ...draft, existingCode: e.target.value })
            }
          />
        </label>
        <label className="mt-4 block">
          Previous source
          <textarea
            className={cn(field, "mt-2 min-h-24 font-mono text-xs")}
            value={draft.previousSource}
            onChange={(e) =>
              setDraft({ ...draft, previousSource: e.target.value })
            }
          />
        </label>
      </details>
      {error && (
        <p role="alert" className="text-red-500 text-sm">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={save.isPending} type="submit">
          Save case
        </Button>
      </div>
    </form>
  );
}

/** Configures a candidate prompt and browses immutable experiment history. */
function Experiment({
  datasetId,
  cases,
  runs,
  runId,
  setRunId,
  onStarted,
}: {
  datasetId: string;
  cases: (EvalCase & { id: string })[];
  runs: RouterOutputs["evaluations"]["detail"]["runs"];
  runId: string;
  setRunId: (id: string) => void;
  onStarted: () => void;
}) {
  const prompts = api.evaluations.prompts.useQuery();
  const [mode, setMode] = useState<"discovery" | "verification">("discovery");
  const [split, setSplit] = useState<"development" | "holdout">("development");
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<Partial<Record<typeof mode, string>>>(
    {},
  );
  const prompt = drafts[mode] ?? prompts.data?.[mode] ?? "";
  const count = cases.filter(
    (row) => row.label !== "unlabeled" && row.split === split,
  ).length;
  const start = api.evaluations.startRun.useMutation({
    onSuccess: (run) => {
      setRunId(run.id);
      onStarted();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="space-y-5">
      <section className={cn(panel, "flex flex-wrap items-end gap-3")}>
        <label className="min-w-0 flex-1 text-xs font-medium text-mist">
          Experiment history
          <select
            aria-label="Experiment history"
            className={cn(field, "mt-2")}
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
          >
            <option value="">New experiment</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          aria-label="New experiment"
          title="New experiment"
          className="size-11 shrink-0 px-0 sm:w-auto sm:px-4"
          onClick={() => setRunId("")}
        >
          <Plus className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">New experiment</span>
        </Button>
      </section>
      {runId ? (
        <RunResults datasetId={datasetId} runId={runId} runs={runs} />
      ) : (
        <form
          className={cn(panel, "space-y-5")}
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate({ datasetId, name, mode, split, prompt });
          }}
        >
          <h2 className="text-cloud text-lg font-semibold">
            Try a candidate prompt
          </h2>
          <div className="sm:hidden">
            <label className="text-mist text-sm">
              Review stage
              <select
                className={cn(field, "mt-2")}
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="discovery">Frozen-file discovery</option>
                <option value="verification">Finding verification</option>
              </select>
            </label>
            <p className="text-mist mt-2 text-xs leading-5">
              {mode === "discovery"
                ? "Find the issue without seeing the answer. Match findings before scoring."
                : "Test whether the verifier keeps real bugs and rejects false alarms. Scored automatically."}
            </p>
          </div>
          <div className="hidden gap-4 sm:grid sm:grid-cols-2">
            {(["discovery", "verification"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  "rounded-xl border p-4 text-left",
                  mode === value ? "border-lime bg-lime/5" : "border-line",
                )}
                aria-pressed={mode === value}
              >
                <span className="text-cloud text-sm font-semibold">
                  {value === "discovery"
                    ? "Frozen-file discovery"
                    : "Finding verification"}
                </span>
                <span className="text-mist mt-2 block text-xs leading-5">
                  {value === "discovery"
                    ? "Can the scout find the issue without seeing the expected answer? Match reported findings before scoring."
                    : "Does the production refuter retain real bugs and reject false positives? Decisions are scored automatically."}
                </span>
              </button>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-mist text-sm">
              Experiment name
              <input
                required
                maxLength={120}
                className={cn(field, "mt-2")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Baseline / stronger evidence requirement"
              />
            </label>
            <label className="text-mist text-sm">
              Evaluate split
              <select
                className={cn(field, "mt-2")}
                value={split}
                onChange={(e) => setSplit(e.target.value as typeof split)}
              >
                <option value="development">Development</option>
                <option value="holdout">Holdout</option>
              </select>
            </label>
          </div>
          <label className="text-mist block text-sm">
            Candidate system prompt
            <textarea
              required
              spellCheck={false}
              className={cn(
                field,
                "mt-2 h-52 font-mono text-xs leading-5 sm:h-72",
              )}
              value={prompt}
              onChange={(e) => setDrafts({ ...drafts, [mode]: e.target.value })}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              type="button"
              onClick={() =>
                setDrafts({ ...drafts, [mode]: prompts.data?.[mode] })
              }
            >
              Reset to live prompt
            </Button>
            <Link
              href="/settings/ai"
              className="text-cyan inline-flex items-center gap-1 text-xs"
            >
              Live prompt settings
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
          <p className="text-mist text-xs leading-5">
            {count} labeled {split} cases · Provider usage applies. Live prompts
            stay unchanged.
          </p>
          <details className="text-mist text-xs">
            <summary className="cursor-pointer text-cyan">Run limits</summary>
            <p className="mt-2 leading-5">
              Maximum 50 cases per run and one active run per workspace.{" "}
              {mode === "discovery"
                ? "Up to 6 model steps per case."
                : "One verification call per case."}
            </p>
          </details>
          {split === "holdout" && (
            <p className="text-amber-700 dark:text-amber-200 text-sm">
              Reserve holdout runs for final validation. Repeated tuning against
              these results turns them into development data.
            </p>
          )}
          <Button
            type="submit"
            disabled={!count || count > 50 || !prompt}
            loading={start.isPending}
          >
            <Play className="size-4" />
            Run {count} cases
          </Button>
        </form>
      )}
    </div>
  );
}

/** Shows metrics with denominators so an empty class never appears perfect. */
function Metrics({ run }: { run: Run }) {
  const metrics = run.metrics;
  return (
    <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
      {[
        [
          "Precision",
          metrics.precision,
          `${metrics.tp} TP / ${metrics.tp + metrics.fp} reported`,
        ],
        [
          run.snapshot.mode === "verification" ? "Bug retention" : "Recall",
          metrics.recall,
          `${metrics.tp} TP / ${metrics.tp + metrics.fn} real bugs`,
        ],
        [
          "False-positive rate",
          metrics.falsePositiveRate,
          `${metrics.fp} FP / ${metrics.fp + metrics.tn} negative cases`,
        ],
      ].map(([title, value, copy]) => (
        <div
          key={String(title)}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl border border-line bg-surface-subtle px-3 py-2.5 sm:block sm:p-5"
        >
          <p className="text-mist text-xs">{title}</p>
          <p className="text-cloud col-start-2 row-span-2 row-start-1 text-2xl font-semibold sm:mt-3 sm:text-3xl">
            {value === null ? "—" : `${Math.round(Number(value) * 100)}%`}
          </p>
          <p className="text-fog col-start-1 row-start-2 mt-1 text-[10px] leading-4 sm:mt-2 sm:text-xs">
            {copy}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Presents per-case outcomes and explicit human matching for discovery runs. */
function RunResults({
  datasetId,
  runId,
  runs,
}: {
  datasetId: string;
  runId: string;
  runs: RouterOutputs["evaluations"]["detail"]["runs"];
}) {
  const utils = api.useUtils();
  const run = api.evaluations.run.useQuery(
    { datasetId, runId },
    {
      refetchInterval: (query) =>
        query.state.data?.status === "running" ? 2000 : false,
    },
  );
  const [baselineId, setBaselineId] = useState("");
  const baseline = api.evaluations.run.useQuery(
    { datasetId, runId: baselineId },
    { enabled: Boolean(baselineId) },
  );
  const grade = api.evaluations.grade.useMutation({
    onSuccess: () => void utils.evaluations.run.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const cancel = api.evaluations.cancel.useMutation({
    onSuccess: () => {
      void run.refetch();
      void utils.evaluations.detail.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const data = run.data;
  if (!data)
    return (
      <p className="text-mist" role="status">
        {run.error?.message ?? "Loading experiment…"}
      </p>
    );
  const pending = data.cases.filter((row) => !row.result).length;
  const ungraded = data.cases.filter(
    (row) => row.result?.prediction === "ungraded",
  ).length;
  const failed = data.cases.filter(
    (row) => row.result?.prediction === "error",
  ).length;
  const comparable =
    baseline.data &&
    baseline.data.snapshot.mode === data.snapshot.mode &&
    baseline.data.snapshot.split === data.snapshot.split &&
    JSON.stringify(
      [...baseline.data.snapshot.cases].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    ) ===
      JSON.stringify(
        [...data.snapshot.cases].sort((a, b) => a.id.localeCompare(b.id)),
      );
  return (
    <section className={cn(panel, "space-y-5")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lime text-xs font-semibold uppercase tracking-widest">
            {data.snapshot.mode === "discovery"
              ? "Frozen-file discovery"
              : "Finding verification"}{" "}
            · {data.snapshot.split}
          </p>
          <h2 className="text-cloud mt-2 text-lg font-semibold [overflow-wrap:anywhere] sm:text-xl">
            {data.name}
          </h2>
          <p className="text-fog mt-2 text-xs [overflow-wrap:anywhere]">
            {data.snapshot.model} · {data.createdAt.toLocaleString()} ·{" "}
            {data.status}
          </p>
        </div>
        {data.status === "running" ? (
          <Button
            variant="secondary"
            loading={cancel.isPending}
            onClick={() => cancel.mutate({ datasetId, runId })}
          >
            Cancel run
          </Button>
        ) : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-subtle">
        <div
          className="h-full rounded-full bg-lime transition-all"
          style={{
            width: `${(100 * (data.cases.length - pending)) / data.cases.length}%`,
          }}
        />
      </div>
      <p className="text-mist text-sm" role="status">
        {data.cases.length - pending}/{data.cases.length} executed ·{" "}
        {data.metrics.graded} scored · {ungraded} need matching · {failed}{" "}
        failed
        {pending
          ? ` · ${pending} ${data.status === "running" ? "pending" : "not executed"}`
          : ""}
      </p>
      {(pending > 0 || ungraded > 0 || failed > 0) && (
        <p className="text-amber-700 dark:text-amber-200 text-sm">
          Unscored cases: {pending + ungraded + failed}. Scores are provisional.
          Compare complete runs before choosing a prompt.
        </p>
      )}
      <Metrics run={data} />
      <details className="text-mist text-xs">
        <summary className="cursor-pointer py-1 text-cyan">
          How scoring works
        </summary>{" "}
        <p className="text-fog mt-2 text-xs leading-5">
          Metrics describe these curated cases, not production-wide accuracy.{" "}
          {data.snapshot.mode === "verification"
            ? "Bug retention measures known findings kept by the refuter; it does not measure discovery recall."
            : "Recall requires known missed bugs as well as previously reported findings. Only the specific target issue counts as a match."}{" "}
          Failures, pending cases and unmatched outputs do not count as passes.
          A dash means no scored samples for that denominator.
        </p>
      </details>
      <label className="text-mist flex flex-wrap items-center gap-3 text-sm">
        Compare with
        <select
          className={cn(field, "max-w-full sm:w-auto")}
          aria-label="Compare baseline"
          value={baselineId}
          onChange={(e) => setBaselineId(e.target.value)}
        >
          <option value="">Choose a baseline</option>
          {runs
            .filter((row) => row.id !== runId)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
        </select>
      </label>
      {baseline.data && (
        <div className="rounded-xl border border-line p-4">
          <h3 className="text-cloud mb-3 text-sm font-medium">
            Baseline: {baseline.data.name}
          </h3>
          {comparable ? (
            <Metrics run={baseline.data} />
          ) : (
            <p className="text-amber-700 dark:text-amber-200 text-sm">
              These runs use different cases, annotations, splits or modes.
              Their aggregate scores are not directly comparable.
            </p>
          )}
        </div>
      )}
      <details className="text-mist text-sm">
        <summary className="cursor-pointer">Captured prompt & usage</summary>
        <p className="my-3 text-xs">
          {data.cases.reduce(
            (sum, row) => sum + (row.result?.inputTokens ?? 0),
            0,
          )}{" "}
          input tokens ·{" "}
          {data.cases.reduce(
            (sum, row) => sum + (row.result?.outputTokens ?? 0),
            0,
          )}{" "}
          output tokens · Runner v{data.snapshot.version}
        </p>
        <pre className="bg-code max-h-72 overflow-auto whitespace-pre-wrap rounded-xl p-4 text-xs">
          {
            data.snapshot.prompts[
              data.snapshot.mode === "discovery"
                ? "deep_review.scout.system_repository"
                : "deep_review.refute.system"
            ]
          }
        </pre>
      </details>
      <h3 className="text-cloud text-base font-semibold">
        Inspect every outcome
      </h3>
      <div className="space-y-3">
        {data.cases.map((row) => {
          const prediction = row.result?.prediction;
          const correct =
            (prediction === "report" && row.label === "bug") ||
            (prediction === "suppress" && row.label === "false_positive");
          const outcome = !prediction
            ? "Not executed"
            : prediction === "ungraded"
              ? "Needs matching"
              : prediction === "error"
                ? "Execution failed"
                : correct
                  ? "Pass"
                  : row.label === "bug"
                    ? "Missed bug"
                    : "False alarm";
          const before = comparable
            ? baseline.data?.cases.find((other) => other.id === row.id)?.result
                ?.prediction
            : undefined;
          return (
            <details key={row.id} className="rounded-xl border border-line p-4">
              <summary className="cursor-pointer">
                <span className="text-cloud mr-3 text-sm font-medium [overflow-wrap:anywhere]">
                  {row.title}
                </span>
                <span
                  className={cn("text-xs", correct ? "text-lime" : "text-mist")}
                >
                  {outcome}
                </span>
                {before && before !== prediction && (
                  <span className="text-cyan ml-3 text-xs">
                    Changed from {before}
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-4">
                <div className="flex items-center gap-3">
                  <Label value={row.label} />
                  <span className="text-fog min-w-0 break-all font-mono text-xs">
                    {row.path}
                  </span>
                </div>
                <p className="text-cloud text-sm">{row.finding}</p>
                <p className="text-mist text-sm">{row.rationale}</p>
                <details className="text-mist text-xs">
                  <summary className="cursor-pointer">Frozen source</summary>
                  <pre className="bg-code mt-3 max-h-72 overflow-auto rounded-lg p-3">
                    {row.source}
                  </pre>
                </details>
                <pre className="bg-code text-mist max-h-96 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs">
                  {row.result?.output ?? "No model output was recorded."}
                </pre>
                {data.snapshot.mode === "discovery" &&
                  row.result &&
                  prediction !== "error" && (
                    <div className="space-y-3">
                      <p className="text-cloud text-sm">
                        Did the output report this specific target issue?
                      </p>
                      <p className="text-fog text-xs">
                        For a false-positive case, choose “Reported” only if the
                        model repeated the false alarm. Other findings do not
                        count.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(["report", "suppress", "ungraded"] as const).map(
                          (value) => (
                            <Button
                              key={value}
                              variant={
                                prediction === value ? "primary" : "secondary"
                              }
                              size="sm"
                              disabled={grade.isPending}
                              onClick={() =>
                                grade.mutate({
                                  datasetId,
                                  runId,
                                  resultId: row.result?.id ?? "",
                                  prediction: value,
                                })
                              }
                            >
                              {value === "report"
                                ? "Reported target issue"
                                : value === "suppress"
                                  ? "Did not report it"
                                  : "Leave ungraded"}
                            </Button>
                          ),
                        )}
                      </div>
                    </div>
                  )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
