"use client";

import { useEffect, useRef, useState } from "react";
import { prepareMermaidSource } from "~/lib/review-mermaid";
import { cn } from "~/lib/utils";

type DiagramStatus = "loading" | "ready" | "error";

const MERMAID_RENDER_TIMEOUT_MS = 8_000;

let mermaidLoader: Promise<typeof import("mermaid").default> | undefined;
let mermaidTheme: "dark" | "neutral" | undefined;
let mermaidRenderSerial = 0;

/** Loads Mermaid once so documentation previews do not pay for it up front. */
function mermaidRuntime() {
  mermaidLoader ??= import("mermaid").then((module) => module.default);
  return mermaidLoader;
}

/** Applies the document theme without resetting Mermaid on every fence. */
function syncMermaidTheme(mermaid: typeof import("mermaid").default) {
  const theme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "neutral";
  if (mermaidTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    fontFamily: "inherit",
    theme,
  });
  mermaidTheme = theme;
}

/** Fails a hung Mermaid render so Preview never stays on a spinner. */
function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error("Timed out drawing this Mermaid diagram."));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        window.clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/** Parses, then draws one diagram with a unique SVG id. */
async function renderMermaidDiagram(chart: string) {
  const mermaid = await mermaidRuntime();
  syncMermaidTheme(mermaid);
  await mermaid.parse(chart);
  mermaidRenderSerial += 1;
  return mermaid.render(`review-mermaid-${mermaidRenderSerial}`, chart);
}

/**
 * Turns a Mermaid fence into an SVG inside the Markdown preview.
 *
 * The library stays on a separate chunk until a documentation file actually
 * contains a diagram. The source stays visible until the SVG is ready so a
 * Compare pane cannot look empty while Mermaid loads or remounts.
 */
export function ReviewMermaidDiagram({
  chart,
  className,
}: {
  chart: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<DiagramStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const source = prepareMermaidSource(chart);

  useEffect(() => {
    const host = hostRef.current;
    if (!source) {
      setStatus("error");
      setError("This Mermaid diagram is empty.");
      if (host) host.replaceChildren();
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    if (host) host.replaceChildren();
    void withTimeout(renderMermaidDiagram(source), MERMAID_RENDER_TIMEOUT_MS)
      .then((result) => {
        if (cancelled || !hostRef.current) return;
        const svg = new DOMParser().parseFromString(
          result.svg,
          "image/svg+xml",
        ).documentElement;
        if (svg.tagName.toLowerCase() !== "svg") {
          throw new Error("Could not render this Mermaid diagram.");
        }
        hostRef.current.replaceChildren(document.importNode(svg, true));
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (hostRef.current) hostRef.current.replaceChildren();
        setStatus("error");
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not render this Mermaid diagram.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <figure
      className={cn(
        "border-line bg-code my-3 overflow-x-auto rounded-lg border p-3",
        className,
      )}
    >
      {status !== "ready" ? (
        <div>
          {status === "loading" ? (
            <p className="text-fog mb-2 text-[11px]" role="status">
              Drawing diagram…
            </p>
          ) : (
            <p className="text-coral mb-2 text-[11px]" role="status">
              {error ?? "Could not render this Mermaid diagram."}
            </p>
          )}
          <pre className="text-cloud overflow-x-auto font-mono text-[11px] leading-5">
            {chart.trim()}
          </pre>
        </div>
      ) : null}
      <div
        ref={hostRef}
        role="img"
        aria-label="Mermaid diagram"
        hidden={status !== "ready"}
        className="text-cloud [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      />
    </figure>
  );
}
