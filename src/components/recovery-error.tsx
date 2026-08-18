"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useTransition } from "react";
import { Button } from "~/components/ui/button";
import {
  LinkNavigationStatus,
  LinkPendingSpinner,
} from "~/components/ui/link-status";

interface RecoveryErrorProps {
  backHref: string;
  backLabel: string;
  description: string;
  error: Error & { digest?: string };
  eyebrow: string;
  logLabel: string;
  reset: () => void;
  title: string;
}

/** Presents a recoverable application failure without exposing infrastructure details. */
export function RecoveryError({
  backHref,
  backLabel,
  description,
  error,
  eyebrow,
  logLabel,
  reset,
  title,
}: RecoveryErrorProps) {
  const [retrying, startRetry] = useTransition();
  useEffect(() => {
    console.error(logLabel, error);
  }, [error, logLabel]);

  return (
    <main className="bg-ink text-cloud grid min-h-screen place-items-center px-5">
      <section className="w-full max-w-lg rounded-2xl border border-line bg-panel/75 p-6 shadow-2xl shadow-black/10 sm:p-8">
        <p className="text-coral text-[10px] font-semibold tracking-[.16em] uppercase">
          {eyebrow}
        </p>
        <h1 className="mt-3 font-serif text-3xl tracking-tight">{title}</h1>
        <p className="text-mist mt-3 text-sm leading-6">{description}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button loading={retrying} onClick={() => startRetry(reset)}>
            {!retrying && <RefreshCw className="size-4" />}
            Try again
          </Button>
          <Button variant="secondary" asChild>
            <Link href={backHref}>
              <LinkNavigationStatus
                idle={<ArrowLeft className="size-4" />}
                pending={<LinkPendingSpinner />}
              />
              {backLabel}
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
