import { KeyRound, TerminalSquare } from "lucide-react";
import { redirect } from "next/navigation";
import { BrandMark } from "~/components/brand-mark";
import { ThemeToggle } from "~/components/theme-toggle";
import { applicationAuth } from "~/server/auth";

/** Explains how a local owner authorizes a new browser session. */
export default async function LocalSetupPage() {
  const authentication = await applicationAuth();
  if (authentication.userId) redirect("/dashboard");

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-5 py-12">
      <div className="studio-glow pointer-events-none absolute inset-0" />
      <div className="bg-lime pointer-events-none absolute -top-56 -right-56 size-96 rounded-full opacity-70" />

      <section className="bg-surface/90 relative z-10 w-full max-w-lg rounded-3xl border border-line p-7 shadow-[0_28px_90px_var(--app-shadow)] sm:p-9">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-3 font-semibold">
            <BrandMark className="size-10" />
            ReviewDuck.ai
          </span>
          <ThemeToggle />
        </div>

        <span className="text-lime mt-10 grid size-12 place-items-center rounded-2xl bg-lime/10">
          <KeyRound className="size-5" />
        </span>
        <p className="text-lime mt-6 text-xs font-semibold tracking-[.18em] uppercase">
          Local owner session
        </p>
        <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em]">
          Authorize this browser
        </h1>
        <p className="text-mist mt-4 text-sm leading-6">
          ReviewDuck is running, but this browser does not have a local owner
          session yet. Open the one-time owner link printed in the terminal
          where you started the application.
        </p>

        <div className="bg-code mt-7 space-y-4 rounded-2xl border border-line p-4">
          <p className="text-fog flex items-center gap-2 text-xs">
            <TerminalSquare className="size-4" />
            Link missing or expired?
          </p>
          <div>
            <p className="text-fog text-[11px]">Source development</p>
            <code className="text-cloud mt-1 block font-mono text-sm">
              make bootstrap
            </code>
          </div>
          <div>
            <p className="text-fog text-[11px]">Docker appliance</p>
            <code className="text-cloud mt-1 block overflow-x-auto font-mono text-xs">
              docker exec open-review-duck reviewduck-local admin bootstrap
            </code>
          </div>
          <p className="text-fog mt-3 text-xs leading-5">
            Run the matching command in another terminal. It revokes previous
            local sessions and prints a fresh link that expires after 15
            minutes.
          </p>
        </div>
      </section>
    </main>
  );
}
