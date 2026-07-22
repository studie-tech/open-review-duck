import {
  ArrowRight,
  Check,
  ChevronDown,
  GitPullRequest,
  Layers3,
  MessageSquareText,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BrandMark } from "~/components/brand-mark";
import { ThemeToggle } from "~/components/theme-toggle";
import { isLocalDeployment } from "~/server/deployment";

const units = [
  ["MAX_RETRIES", "Constant · reviewed", "done"],
  ["sleep", "Function · reviewed", "done"],
  ["withBackoff", "Function · current", "active"],
  ["fetchPullRequest", "Function · next", "next"],
  ["syncPullRequest", "Function · depth 2", "next"],
] as const;

/** Renders the GitHub mark used by repository links. */
function GithubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="size-[18px] fill-current"
    >
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.26.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.419-1.305.762-1.604-2.665-.305-5.466-1.334-5.466-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 6.502c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.806 5.624-5.479 5.921.43.371.823 1.102.823 2.222v3.293c0 .32.192.694.801.576C20.566 21.894 24 17.396 24 12c0-6.627-5.373-12-12-12Z" />
    </svg>
  );
}

/** Renders the landing-page preview of the guided review workspace. */
function ReviewPreview() {
  return (
    <div className="relative min-w-[760px] overflow-hidden rounded-[20px] border border-line-strong bg-panel shadow-[0_32px_90px_var(--app-shadow)] lg:min-w-0">
      <div className="flex h-14 items-center gap-3 border-b border-line px-4">
        <span className="grid size-7 place-items-center rounded-full border border-line text-xs">
          ←
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">
            Resilient payment synchronization
          </p>
          <p className="text-fog mt-0.5 text-[9px]">acme / payments #284</p>
        </div>
        <div className="text-mist flex items-center gap-2 text-[9px]">
          <span>40% reviewed</span>
          <span className="bg-surface-subtle h-1 w-16 overflow-hidden rounded-full">
            <span className="bg-lime block h-full w-2/5 rounded-full" />
          </span>
        </div>
      </div>

      <div className="grid h-[520px] grid-cols-[170px_minmax(0,1fr)_205px]">
        <aside className="bg-surface-subtle border-r border-line p-3">
          <div className="flex items-center justify-between">
            <p className="text-fog text-[9px] font-bold tracking-[.15em] uppercase">
              Review path
            </p>
            <span className="text-fog rounded-md border border-line px-1.5 py-0.5 text-[8px]">
              5 units
            </span>
          </div>
          <div className="text-fog mt-3 rounded-lg border border-line bg-panel px-2.5 py-2 text-[9px]">
            Find a symbol or file
          </div>
          <div className="mt-3 space-y-1">
            {units.map(([name, detail, status]) => (
              <div
                key={name}
                className={`flex items-center gap-2 rounded-lg px-2 py-2.5 ${
                  status === "active" ? "bg-surface-hover" : ""
                }`}
              >
                <span
                  className={`grid size-3 shrink-0 place-items-center rounded-full ${
                    status === "done"
                      ? "bg-lime text-accent-foreground"
                      : status === "active"
                        ? "border border-cyan bg-cyan/15"
                        : "border border-line-strong"
                  }`}
                >
                  {status === "done" && (
                    <Check className="size-2" strokeWidth={3} />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[9px] font-medium">
                    {name}
                  </span>
                  <span className="text-fog mt-0.5 block truncate text-[7px]">
                    {detail}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col bg-code">
          <div className="flex h-14 items-center justify-between border-b border-line px-4">
            <div>
              <p className="font-mono text-[10px] font-semibold">withBackoff</p>
              <p className="text-fog mt-1 text-[8px]">
                src/lib/retry.ts · lines 18–29
              </p>
            </div>
            <span className="text-mist rounded-md border border-line px-2 py-1 text-[8px]">
              Function
            </span>
          </div>
          <div className="flex-1 overflow-hidden py-3 font-mono text-[9px] leading-[18px]">
            {[
              "export async function withBackoff<T>(",
              "  operation: () => Promise<T>,",
              "  attempts = MAX_RETRIES,",
              ") {",
              "  for (let attempt = 0; attempt < attempts; attempt++) {",
              "    try { return await operation(); }",
              "    catch (error) {",
              "      if (attempt === attempts - 1) throw error;",
            ].map((line, index) => (
              <div
                key={line}
                className="grid grid-cols-[36px_1fr] px-3 text-cloud/80"
              >
                <span className="text-fog text-right">{18 + index}</span>
                <code className="pl-3">{line}</code>
              </div>
            ))}

            <div className="mx-4 my-2 ml-12 rounded-lg border border-amber-600/35 bg-amber-400/10 p-3 font-sans">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[8px] font-bold tracking-[.12em] text-amber-700 uppercase dark:text-amber-300">
                  AI review finding
                </p>
                <span className="rounded-md border border-line px-2 py-1 text-[8px] font-semibold">
                  Send to PR
                </span>
              </div>
              <p className="mt-1.5 text-[10px] font-semibold">
                Retry delay can grow without a ceiling
              </p>
              <p className="text-mist mt-1 text-[9px] leading-4">
                Cap the computed delay to keep recovery time predictable.
              </p>
            </div>
            <div className="bg-surface-hover grid grid-cols-[36px_1fr] px-3 text-cloud/80">
              <span className="text-lime text-right">＋26</span>
              <code className="pl-3"> await sleep(2 ** attempt * 100);</code>
            </div>
            <div className="bg-panel mx-4 mt-2 ml-12 rounded-lg border border-line p-3 font-sans">
              <div className="flex items-center justify-between">
                <p className="text-[9px] font-semibold">Comment on line 26</p>
                <p className="text-fog text-[8px]">src/lib/retry.ts</p>
              </div>
              <div className="text-mist mt-2 rounded-md border border-line bg-code px-2 py-1.5 text-[9px]">
                Could we cap the maximum retry delay?
              </div>
              <div className="mt-2 flex justify-end gap-2 text-[8px]">
                <span>Cancel</span>
                <span className="bg-lime text-accent-foreground rounded-md px-2 py-1 font-bold">
                  Review comment
                </span>
              </div>
            </div>
          </div>
          <div className="bg-surface-subtle flex h-12 items-center justify-between border-t border-line px-4">
            <span className="text-fog text-[9px]">2 of 5 reviewed</span>
            <span className="bg-lime text-accent-foreground rounded-lg px-3 py-2 text-[9px] font-bold">
              ✓ Sign off
            </span>
          </div>
        </section>

        <aside className="bg-surface-subtle border-l border-line p-3">
          <div className="h-11 border-b border-line">
            <span className="text-violet flex w-full items-center justify-between rounded-md border border-line px-2 py-1 text-[8px] font-semibold">
              <span className="flex items-center gap-1.5">
                <Sparkles className="size-3" />
                AI assistance
              </span>
              <span className="flex items-center gap-1.5">
                <span className="rounded border border-line px-1">E</span>
                <ChevronDown className="size-2.5" />
              </span>
            </span>
          </div>
          <div className="mt-3 rounded-lg border border-line bg-surface p-3">
            <p className="text-fog text-[8px]">Function · Lines 18–29</p>
            <p className="mt-1.5 font-mono text-[10px] font-semibold">
              withBackoff
            </p>
            <p className="text-fog mt-0.5 text-[8px]">src/lib/retry.ts</p>
          </div>
          <div className="border-cyan/30 bg-cyan/8 mt-3 rounded-lg border p-3">
            <p className="text-fog text-[8px] font-bold tracking-[.1em] uppercase">
              About this function
            </p>
            <p className="mt-2 text-[9px] leading-4">
              Retries an asynchronous operation using exponential backoff and
              rethrows the final underlying error.
            </p>
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-fog text-[8px] font-bold tracking-[.1em] uppercase">
              Why this unit is next
            </p>
            <p className="text-mist mt-2 text-[9px] leading-4">
              Its lower-level building blocks have already been reviewed.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Renders the public ReviewDuck landing page. */
export default function Home() {
  if (isLocalDeployment()) redirect("/dashboard");
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="studio-glow pointer-events-none absolute inset-0" />
      <div className="bg-lime pointer-events-none absolute -top-72 -right-72 size-[500px] rounded-full opacity-80 dark:opacity-90" />

      <nav className="relative z-10 mx-auto flex max-w-[1380px] items-center justify-between border-b border-line px-5 py-5 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-3 font-semibold tracking-tight"
        >
          <BrandMark className="size-10" />
          <span>ReviewDuck.ai</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            className="text-mist hover:text-cloud hover:bg-surface-hover grid size-10 place-items-center rounded-xl border border-line bg-surface/75 transition"
            href="https://github.com/studie-tech/open-review-duck"
            target="_blank"
            rel="noreferrer"
            aria-label="Open ReviewDuck on GitHub"
            title="Open ReviewDuck on GitHub"
          >
            <GithubIcon />
          </Link>
          <ThemeToggle />
          <Link
            className="bg-cloud text-ink hidden rounded-xl px-4 py-2.5 text-sm font-semibold transition hover:opacity-85 sm:block"
            href="/dashboard"
          >
            Open workspace
          </Link>
        </div>
      </nav>

      <section
        id="product"
        className="relative z-[1] mx-auto grid max-w-[1380px] items-center gap-12 px-5 pt-16 pb-24 sm:px-8 lg:grid-cols-[.7fr_1.3fr] lg:gap-14 lg:pt-20"
      >
        <div className="max-w-xl">
          <p className="text-fog text-[10px] font-bold tracking-[.18em] uppercase">
            A human-centric pull request reviewer
          </p>
          <h1 className="font-editorial mt-7 text-5xl leading-[.94] font-medium tracking-[-.055em] text-balance sm:text-7xl lg:text-[4.7rem]">
            Make code review feel like{" "}
            <span className="text-lime italic">working it out together.</span>
          </h1>
          <p className="text-mist mt-7 max-w-lg text-base leading-7 text-pretty">
            Follow the logic from independent building blocks to the complete
            feature. Keep every explanation, finding, and conversation attached
            to the exact code it belongs to.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/dashboard"
              className="bg-lime text-accent-foreground group inline-flex items-center justify-center gap-2 rounded-xl border border-lime px-5 py-3.5 text-sm font-semibold shadow-[0_12px_35px_var(--app-shadow)] transition hover:-translate-y-px hover:bg-accent-hover"
            >
              Review a pull request
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="#workflow"
              className="inline-flex items-center justify-center rounded-xl border border-line-strong bg-surface/55 px-5 py-3.5 text-sm font-medium transition hover:bg-surface-hover"
            >
              See how it works
            </Link>
          </div>
          <div className="text-mist mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <GitPullRequest className="size-4 text-lime" />
            <span>GitHub</span>
            <span>GitLab</span>
            <span>Azure DevOps</span>
            <span className="h-4 w-px bg-line" />
            <span>JavaScript · TypeScript · Python</span>
          </div>
        </div>

        <div className="overflow-x-auto p-1 lg:overflow-visible">
          <ReviewPreview />
        </div>
      </section>

      <section
        id="workflow"
        className="relative border-t border-line bg-panel/55"
      >
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <div className="max-w-2xl">
            <p className="text-lime text-xs font-semibold tracking-[.16em] uppercase">
              Review with context
            </p>
            <h2 className="font-editorial mt-4 text-4xl tracking-[-.04em] sm:text-5xl">
              Your understanding becomes part of the workflow.
            </h2>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {[
              [
                Layers3,
                "Start with foundations",
                "Static analysis creates a calm path from independent utilities to the logic that depends on them.",
              ],
              [
                MessageSquareText,
                "Keep feedback beside code",
                "Ask for an explanation, inspect AI findings, and publish comments without losing your place.",
              ],
              [
                RefreshCw,
                "Revisit only what changed",
                "Semantic sign-offs survive new commits until the reviewed code—or logic that affects it—changes.",
              ],
            ].map(([Icon, title, body], index) => {
              const FeatureIcon = Icon as typeof Layers3;
              return (
                <article
                  key={String(title)}
                  className="bg-surface rounded-2xl border border-line p-7 shadow-[0_18px_50px_var(--app-shadow)]"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-lime grid size-10 place-items-center rounded-xl bg-lime/10">
                      <FeatureIcon className="size-5" />
                    </span>
                    <span className="text-fog font-mono text-xs">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-8 text-lg font-semibold tracking-tight">
                    {String(title)}
                  </h3>
                  <p className="text-mist mt-3 text-sm leading-6">
                    {String(body)}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto flex max-w-4xl flex-col items-center px-5 py-20 text-center sm:px-8">
          <Sparkles className="size-5 text-violet" />
          <h2 className="font-editorial mt-5 text-4xl tracking-[-.04em]">
            Spend attention where it matters.
          </h2>
          <p className="text-mist mt-4 max-w-xl text-sm leading-6">
            Bring your own AI provider or use managed models. Assistance is
            optional, transparent, and always anchored to the code under review.
          </p>
          <Link
            href="/dashboard"
            className="bg-lime text-accent-foreground mt-8 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold"
          >
            Open the workspace <Send className="size-4" />
          </Link>
        </div>
      </section>

      <footer className="text-fog flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-line px-5 py-8 text-xs">
        <span>© 2026 ReviewDuck</span>
        <a
          href="https://github.com/studie-tech/open-review-duck"
          className="transition hover:text-cloud"
        >
          Source
        </a>
        <a
          href="https://github.com/studie-tech/open-review-duck/blob/main/LICENSE"
          className="transition hover:text-cloud"
        >
          AGPL-3.0
        </a>
        <span>No warranty</span>
      </footer>
    </main>
  );
}
