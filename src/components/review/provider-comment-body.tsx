"use client";

import { ChevronRight } from "lucide-react";
import {
  Children,
  type ComponentPropsWithoutRef,
  isValidElement,
  memo,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { isMermaidSource } from "~/lib/review-mermaid";
import { cn } from "~/lib/utils";
import { ReviewMermaidDiagram } from "./review-mermaid-diagram";

const providerCommentSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), "open"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
};

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm];

const rehypePlugins: Options["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, providerCommentSchema],
];

const markdownComponents: Options["components"] = {
  a: SafeProviderLink,
  blockquote: ({ children }) => (
    <blockquote className="border-cyan/25 text-mist my-3 border-l-2 pl-3">
      {children}
    </blockquote>
  ),
  code: ({ children, className: codeClassName }) => (
    <code
      className={cn(
        "bg-surface-subtle rounded-[4px] px-1.5 py-0.5 font-mono text-[.9em] text-cloud",
        codeClassName,
      )}
    >
      {children}
    </code>
  ),
  details: ({ children, open }) => (
    <details
      open={open}
      className="group border-line bg-surface-subtle/30 my-4 overflow-hidden rounded-lg border [&>:not(summary)]:mx-3 [&>:last-child]:mb-3"
    >
      {children}
    </details>
  ),
  h1: ({ children }) => (
    <h1 className="text-cloud mt-4 mb-2 text-base font-semibold">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-cloud mt-4 mb-2 text-sm font-semibold">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-cloud mt-3 mb-1.5 text-xs font-semibold">{children}</h3>
  ),
  hr: () => <hr className="my-4 border-line" />,
  img: ProviderImagePlaceholder,
  li: ({ children }) => <li className="ml-5 pl-0.5">{children}</li>,
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1">{children}</ol>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0">{children}</p>,
  pre: MarkdownPre,
  strong: ({ children }) => (
    <strong className="font-semibold text-cloud">{children}</strong>
  ),
  summary: ({ children }) => (
    <summary className="text-cloud hover:bg-surface-hover flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium transition select-none [&::-webkit-details-marker]:hidden">
      <ChevronRight
        className="text-cyan size-3.5 shrink-0 transition-transform group-open:rotate-90"
        aria-hidden="true"
      />
      <span>{children}</span>
    </summary>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  td: ({ children }) => (
    <td className="border-t border-line px-2 py-1.5">{children}</td>
  ),
  th: ({ children }) => (
    <th className="bg-surface-subtle px-2 py-1.5 font-semibold text-cloud">
      {children}
    </th>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1">{children}</ul>
  ),
};

const documentMarkdownComponents: Options["components"] = {
  ...markdownComponents,
  h1: ({ children }) => (
    <h1 className="text-cloud mt-6 mb-3 text-xl font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-cloud mt-5 mb-2 text-lg font-semibold">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-cloud mt-4 mb-2 text-base font-semibold">{children}</h3>
  ),
};

/**
 * Renders untrusted provider Markdown and HTML through a strict allowlist.
 *
 * react-markdown runs the whole remark/rehype pipeline synchronously during
 * render, so a comment thread pays the parse and sanitize cost for every body
 * each time its container re-renders — once per keystroke in the reply and
 * edit composers, and once per streamed chunk of an AI answer. The plugin
 * lists and the component map close over nothing, so they live at module
 * scope and the memoized component skips parsing whenever the body is
 * unchanged.
 */
export const ProviderCommentBody = memo(function ProviderCommentBody({
  body,
  className,
  variant = "comment",
}: {
  body: string;
  className?: string;
  variant?: "comment" | "document";
}) {
  return (
    <div
      className={cn(
        "text-mist min-w-0 wrap-break-word",
        variant === "document"
          ? "max-w-[72ch] text-[14px] leading-7"
          : "mt-3 max-w-[96ch] text-[13px] leading-6",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={
          variant === "document"
            ? documentMarkdownComponents
            : markdownComponents
        }
      >
        {body}
      </ReactMarkdown>
    </div>
  );
});

/** Collects text from a Markdown code node so Mermaid can parse the fence. */
function markdownText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return markdownText(node.props.children);
  }
  return "";
}

/**
 * Draws Mermaid and UML fences instead of leaving them as a source listing.
 *
 * react-markdown has already turned the fence into a `pre > code` tree by
 * the time this runs, so the language class and the body both have to be
 * read off that child.
 */
function MarkdownPre({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((child) =>
    isValidElement<{ className?: string; children?: ReactNode }>(child),
  );
  if (isValidElement<{ className?: string; children?: ReactNode }>(code)) {
    const language = /language-([^\s]+)/.exec(code.props.className ?? "")?.[1];
    const source = markdownText(code.props.children);
    if (isMermaidSource(language, source)) {
      return <ReviewMermaidDiagram chart={source} />;
    }
  }
  return (
    <pre className="border-line bg-code my-3 overflow-x-auto rounded-lg border p-3 text-[11px] leading-5 text-cloud [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  );
}

/** Keeps provider links inert unless sanitization retained a safe URL. */
function SafeProviderLink({ children, href }: ComponentPropsWithoutRef<"a">) {
  if (!href) return <span>{children}</span>;
  const external = href.startsWith("http://") || href.startsWith("https://");
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="text-cyan underline decoration-cyan/30 underline-offset-2 transition hover:decoration-cyan"
    >
      {children}
    </a>
  );
}

/** Represents untrusted remote images locally without making tracking requests. */
function ProviderImagePlaceholder({
  alt,
  title,
}: ComponentPropsWithoutRef<"img">) {
  const label = alt?.trim() || title?.trim() || "Attached image";
  const priority = /^P[0-4]$/iu.test(label);
  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      className={cn(
        "border-line bg-surface-subtle text-mist my-1.5 inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium",
        priority &&
          "border-amber-500/25 bg-amber-400/10 font-semibold tracking-[.08em] text-amber-800 uppercase dark:text-amber-200",
      )}
    >
      {label}
    </span>
  );
}
