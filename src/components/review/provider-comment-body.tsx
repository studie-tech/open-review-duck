"use client";

import { ChevronRight, ImageIcon, Maximize2 } from "lucide-react";
import {
  Children,
  type ComponentPropsWithoutRef,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { canAutomaticallyPreviewCommentImage } from "~/lib/comment-images";
import {
  markdownChangeAttributes,
  rehypeMarkdownChanges,
} from "~/lib/markdown-diff";
import { isMermaidSource } from "~/lib/review-mermaid";
import { cn } from "~/lib/utils";
import { ReviewMermaidDiagram } from "./review-mermaid-diagram";

const MarkdownSourceActionContext = createContext<
  ((startLine: number, endLine: number) => ReactNode) | undefined
>(undefined);

/** Offers source actions using parser positions rather than author-supplied attributes. */
function MarkdownSourceAction({
  node,
}: {
  node?: Parameters<typeof markdownChangeAttributes>[0];
}) {
  const renderAction = useContext(MarkdownSourceActionContext);
  const position = node?.position;
  return position && renderAction ? (
    <span className="float-right ml-2 font-sans text-xs font-normal">
      {renderAction(position.start.line, position.end.line)}
    </span>
  ) : null;
}

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
  h1: ({ children, node }) => (
    <h1
      {...markdownChangeAttributes(node)}
      className="text-cloud mt-4 mb-2 text-base font-semibold"
    >
      {children}
    </h1>
  ),
  h2: ({ children, node }) => (
    <h2
      {...markdownChangeAttributes(node)}
      className="text-cloud mt-4 mb-2 text-sm font-semibold"
    >
      {children}
    </h2>
  ),
  h3: ({ children, node }) => (
    <h3
      {...markdownChangeAttributes(node)}
      className="text-cloud mt-3 mb-1.5 text-xs font-semibold"
    >
      {children}
    </h3>
  ),
  hr: ({ node }) => (
    <>
      <MarkdownSourceAction node={node} />
      <hr {...markdownChangeAttributes(node)} className="my-4 border-line" />
    </>
  ),
  img: ProviderImagePlaceholder,
  li: ({ children, node }) => (
    <li {...markdownChangeAttributes(node)} className="ml-5 pl-0.5">
      <MarkdownSourceAction node={node} />
      {children}
    </li>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1">{children}</ol>
  ),
  p: ({ children, node }) => (
    <p {...markdownChangeAttributes(node)} className="my-2 first:mt-0">
      <MarkdownSourceAction node={node} />
      {children}
    </p>
  ),
  pre: MarkdownPre,
  strong: ({ children }) => (
    <strong className="font-semibold text-cloud">{children}</strong>
  ),
  summary: ({ children, node }) => (
    <summary
      {...markdownChangeAttributes(node)}
      className="text-cloud hover:bg-surface-hover flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium transition select-none [&::-webkit-details-marker]:hidden"
    >
      <ChevronRight
        className="text-cyan size-3.5 shrink-0 transition-transform group-open:rotate-90"
        aria-hidden="true"
      />
      <span>{children}</span>
      <MarkdownSourceAction node={node} />
    </summary>
  ),
  tr: ({ children, node }) => (
    <tr {...markdownChangeAttributes(node)}>{children}</tr>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  td: ({ children, node }) => (
    <td className="border-t border-line px-2 py-1.5">
      <MarkdownSourceAction node={node} />
      {children}
    </td>
  ),
  th: ({ children, node }) => (
    <th className="bg-surface-subtle px-2 py-1.5 font-semibold text-cloud">
      <MarkdownSourceAction node={node} />
      {children}
    </th>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1">{children}</ul>
  ),
};

const documentMarkdownComponents: Options["components"] = {
  ...markdownComponents,
  h1: ({ children, node }) => (
    <>
      <MarkdownSourceAction node={node} />
      <h1
        {...markdownChangeAttributes(node)}
        className="text-cloud mt-6 mb-3 text-xl font-semibold first:mt-0"
      >
        {children}
      </h1>
    </>
  ),
  h2: ({ children, node }) => (
    <>
      <MarkdownSourceAction node={node} />
      <h2
        {...markdownChangeAttributes(node)}
        className="text-cloud mt-5 mb-2 text-lg font-semibold"
      >
        {children}
      </h2>
    </>
  ),
  h3: ({ children, node }) => (
    <>
      <MarkdownSourceAction node={node} />
      <h3
        {...markdownChangeAttributes(node)}
        className="text-cloud mt-4 mb-2 text-base font-semibold"
      >
        {children}
      </h3>
    </>
  ),
  h4: ({ children, node }) => (
    <>
      <MarkdownSourceAction node={node} />
      <h4
        {...markdownChangeAttributes(node)}
        className="text-cloud mt-3 mb-2 text-sm font-semibold"
      >
        {children}
      </h4>
    </>
  ),
  h5: ({ children, node }) => (
    <>
      <MarkdownSourceAction node={node} />
      <h5
        {...markdownChangeAttributes(node)}
        className="text-cloud mt-3 mb-2 text-sm font-semibold"
      >
        {children}
      </h5>
    </>
  ),
  h6: ({ children, node }) => (
    <>
      <MarkdownSourceAction node={node} />
      <h6
        {...markdownChangeAttributes(node)}
        className="text-cloud mt-3 mb-2 text-sm font-semibold"
      >
        {children}
      </h6>
    </>
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
  changes,
  renderSourceAction,
  imageMode = "placeholder",
  imageBaseUrl,
  onOpenImage,
}: {
  body: string;
  className?: string;
  variant?: "comment" | "document";
  changes?: { lines: readonly number[]; side: "previous" | "current" };
  renderSourceAction?: (startLine: number, endLine: number) => ReactNode;
  imageMode?: "placeholder" | "preview";
  /** Resolves provider-relative attachment paths without using the app origin. */
  imageBaseUrl?: string;
  onOpenImage?: (image: { src: string; alt: string }) => void;
}) {
  const plugins = useMemo<Options["rehypePlugins"]>(
    () =>
      changes
        ? [...rehypePlugins, [rehypeMarkdownChanges, changes]]
        : rehypePlugins,
    [changes],
  );
  const components = useMemo<Options["components"]>(() => {
    const base =
      variant === "document" ? documentMarkdownComponents : markdownComponents;
    return imageMode === "preview"
      ? {
          ...base,
          a: (props) => <SafeProviderLink {...props} imagePreviews />,
          img: (props) => (
            <ProviderImagePreview
              {...props}
              baseUrl={imageBaseUrl}
              onOpen={onOpenImage}
            />
          ),
        }
      : base;
  }, [imageMode, imageBaseUrl, onOpenImage, variant]);
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
      <MarkdownSourceActionContext.Provider value={renderSourceAction}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={plugins}
          components={components}
        >
          {body}
        </ReactMarkdown>
      </MarkdownSourceActionContext.Provider>
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
function MarkdownPre({
  children,
  node,
}: {
  children?: ReactNode;
  node?: Parameters<typeof markdownChangeAttributes>[0];
}) {
  const code = Children.toArray(children).find((child) =>
    isValidElement<{ className?: string; children?: ReactNode }>(child),
  );
  if (isValidElement<{ className?: string; children?: ReactNode }>(code)) {
    const language = /language-([^\s]+)/.exec(code.props.className ?? "")?.[1];
    const source = markdownText(code.props.children);
    if (isMermaidSource(language, source)) {
      return (
        <div {...markdownChangeAttributes(node)}>
          <MarkdownSourceAction node={node} />
          <ReviewMermaidDiagram chart={source} />
        </div>
      );
    }
  }
  return (
    <>
      <MarkdownSourceAction node={node} />
      <pre
        {...markdownChangeAttributes(node)}
        className="border-line bg-code my-3 overflow-x-auto rounded-lg border p-3 text-[11px] leading-5 text-cloud [&>code]:bg-transparent [&>code]:p-0"
      >
        {children}
      </pre>
    </>
  );
}

/** Keeps provider links inert unless sanitization retained a safe URL. */
function SafeProviderLink({
  children,
  href,
  imagePreviews = false,
}: ComponentPropsWithoutRef<"a"> & { imagePreviews?: boolean }) {
  if (!href) return <span>{children}</span>;
  const external = href.startsWith("http://") || href.startsWith("https://");
  const link = (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="text-cyan underline decoration-cyan/30 underline-offset-2 transition hover:decoration-cyan"
    >
      {imagePreviews && containsMarkdownImage(children)
        ? "Open linked page"
        : children}
    </a>
  );
  return imagePreviews && containsMarkdownImage(children) ? (
    <span className="inline-flex max-w-full flex-col items-start">
      {children}
      {link}
    </span>
  ) : (
    link
  );
}

/** Finds rendered Markdown image nodes before wrapping their preview controls. */
function containsMarkdownImage(children: ReactNode): boolean {
  return Children.toArray(children).some(
    (child) =>
      isValidElement<{ node?: { tagName?: string }; children?: ReactNode }>(
        child,
      ) &&
      (child.props.node?.tagName === "img" ||
        containsMarkdownImage(child.props.children)),
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

/** Displays sanitized attachments without forwarding the review page referrer. */
function ProviderImagePreview({
  src,
  alt,
  title,
  onOpen,
  baseUrl,
}: ComponentPropsWithoutRef<"img"> & {
  onOpen?: (image: { src: string; alt: string }) => void;
  baseUrl?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const label = alt?.trim() || title?.trim() || "Attached image";
  const imageUrl =
    typeof src === "string" ? providerImageUrl(src, baseUrl) : undefined;
  if (/^P[0-4]$/iu.test(label) || !imageUrl) {
    return <ProviderImagePlaceholder alt={alt} title={title} />;
  }
  if (failedUrl === imageUrl) {
    return (
      <span className="border-line bg-surface-subtle my-3 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs">
        <ImageIcon className="size-4" aria-hidden="true" />
        <span>{label} · Preview unavailable</span>
        <SafeProviderLink href={imageUrl}>Open image</SafeProviderLink>
      </span>
    );
  }
  if (
    !canAutomaticallyPreviewCommentImage(imageUrl, baseUrl) &&
    loadedUrl !== imageUrl
  ) {
    const url = new URL(imageUrl);
    return (
      <span className="border-line bg-surface-subtle my-3 inline-flex max-w-full flex-wrap items-center gap-3 rounded-lg border p-3 text-xs">
        <ImageIcon className="text-fog size-4" aria-hidden="true" />
        <span>
          <span className="text-cloud block font-medium">{label}</span>
          <span className="text-fog text-[10px]">
            External image · {url.host}
          </span>
        </span>
        {url.protocol === "https:" && (
          <button
            type="button"
            onClick={() => setLoadedUrl(imageUrl)}
            className="text-cyan rounded-md px-2 py-1 text-xs! font-medium hover:bg-cyan/10"
          >
            Load image
          </button>
        )}
        <SafeProviderLink href={imageUrl}>Open image</SafeProviderLink>
      </span>
    );
  }
  const preview = (
    <>
      {/* Provider URLs require browser credentials and cannot use Next's image proxy. */}
      {/* biome-ignore lint/performance/noImgElement: preserve provider image access rules */}
      <img
        src={imageUrl}
        alt={label}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(imageUrl)}
        className="max-h-80 w-auto max-w-full rounded-t-lg object-contain"
      />
      <span className="text-mist flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-[11px]">
        <span className="truncate">{label}</span>
        <Maximize2 className="size-3.5 shrink-0" aria-hidden="true" />
      </span>
    </>
  );
  const className =
    "border-line bg-surface my-3 inline-flex max-w-full flex-col overflow-hidden rounded-lg border text-left transition hover:border-cyan/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan";
  return onOpen ? (
    <button
      type="button"
      className={className}
      aria-label={`Enlarge image: ${label}`}
      onClick={() => onOpen({ src: imageUrl, alt: label })}
    >
      {preview}
    </button>
  ) : (
    <a
      href={imageUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {preview}
    </a>
  );
}

/** Resolves sanitized provider image sources while rejecting credential URLs. */
function providerImageUrl(src: string, baseUrl?: string) {
  if (!src.trim()) return undefined;
  try {
    // GitLab Markdown uploads use project-relative /uploads paths.
    const source =
      baseUrl?.includes("/-/merge_requests/") && src.startsWith("/uploads/")
        ? `${baseUrl.split("/-/merge_requests/")[0]}${src}`
        : src;
    const url = new URL(source, baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
