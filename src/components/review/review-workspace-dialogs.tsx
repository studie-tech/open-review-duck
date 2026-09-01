"use client";

import {
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderInput,
  GitBranch,
  Info,
  LoaderCircle,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import {
  type ImportReference,
  type ImportStatement,
  importReferenceIsUsed,
  type PairedImportStatement,
  pairImportStatements,
} from "~/lib/import-navigation";
import { providerLabel } from "~/lib/provider-labels";
import type { ReviewHierarchyNode } from "~/lib/review-navigation";
import { isPeekableToken, symbolPeekAttributes } from "~/lib/symbol-peek";
import { useHighlightedSource } from "~/lib/syntax-highlighting";
import { useImportStatements } from "~/lib/tree-sitter-import-navigation";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { HighlightedTokens } from "./highlighted-tokens";
import { ProviderCommentBody } from "./review-workspace-markdown";

type WorkspaceData = RouterOutputs["review"]["workspace"];
type ReviewUnit = WorkspaceData["units"][number];

export { knownLanguage, supportedLanguage } from "~/lib/syntax-highlighting";

/** Renders the explanation loader interface. */
export function ExplanationLoader({ unitKind }: { unitKind: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-violet/20 bg-violet/[.045] relative mt-4 overflow-hidden rounded-xl border p-4"
    >
      <div
        aria-hidden="true"
        className="bg-violet/10 absolute inset-x-0 top-0 h-px animate-pulse"
      />
      <div className="flex items-start gap-3">
        <span className="bg-violet/10 grid size-8 shrink-0 place-items-center rounded-full">
          <LoaderCircle className="text-violet size-4 animate-spin" />
        </span>
        <div className="min-w-0">
          <p className="text-cloud text-xs font-medium">
            Analyzing this {unitKind}
          </p>
          <p className="text-mist mt-1 text-[10px] leading-4">
            Reading its logic and dependencies to prepare a focused explanation.
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="mt-4 space-y-2">
        <div className="bg-violet/10 h-1.5 w-full animate-pulse rounded-full" />
        <div className="bg-violet/10 h-1.5 w-[86%] animate-pulse rounded-full [animation-delay:120ms]" />
        <div className="bg-violet/10 h-1.5 w-[62%] animate-pulse rounded-full [animation-delay:240ms]" />
      </div>
    </div>
  );
}

/** Renders file imports as relevance-aware context for the focused unit view. */
export function UnitImportContext({
  fileSource,
  previousFileSource,
  unitSource,
  language,
  unitId,
  visibleStartLine,
  visibleEndLine,
  previousVisibleStartLine,
  previousVisibleEndLine,
  resolvingImport,
  continued = false,
  onFollow,
}: {
  fileSource: string;
  previousFileSource?: string;
  unitSource: string;
  language: string;
  unitId: string;
  visibleStartLine: number;
  visibleEndLine: number;
  previousVisibleStartLine?: number;
  previousVisibleEndLine?: number;
  resolvingImport?: string;
  continued?: boolean;
  onFollow: (reference: ImportReference) => void;
}) {
  const currentStatements = useImportStatements(fileSource, language);
  const previousStatements = useImportStatements(
    previousFileSource ?? "",
    language,
  );
  const pairs = useMemo(() => {
    const previousStart = previousVisibleStartLine ?? visibleStartLine;
    const previousEnd = previousVisibleEndLine ?? visibleEndLine;
    return pairImportStatements(previousStatements, currentStatements).filter(
      (pair) => {
        if (pair.kind === "deleted") {
          return (
            pair.previous.endLine < previousStart ||
            pair.previous.startLine > previousEnd
          );
        }
        return (
          pair.current.endLine < visibleStartLine ||
          pair.current.startLine > visibleEndLine
        );
      },
    );
  }, [
    currentStatements,
    previousStatements,
    previousVisibleEndLine,
    previousVisibleStartLine,
    visibleEndLine,
    visibleStartLine,
  ]);
  const usedReferences = useMemo(
    () =>
      new Set(
        currentStatements
          .flatMap(({ references }) => references)
          .filter((reference) => importReferenceIsUsed(reference, unitSource))
          .map((reference) => `${reference.from}:${reference.to}`),
      ),
    [currentStatements, unitSource],
  );
  if (pairs.length === 0) return null;

  return (
    <section
      aria-label="Imports for this unit"
      className={cn(
        "mx-4 -mt-px overflow-hidden border-x border-b border-line bg-surface/35 font-sans",
        continued ? undefined : "mb-3 rounded-b-xl",
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <span className="text-fog flex items-center gap-2 text-[9px] font-semibold tracking-[.12em] uppercase">
          <ArrowUpFromLine className="text-cyan size-3" aria-hidden="true" />
          Imports
        </span>
        <span className="text-fog shrink-0 text-[9px]">
          Declared outside this unit · used names highlighted
        </span>
      </header>
      {pairs.map((pair) => (
        <ImportContextPair
          key={importPairKey(pair)}
          pair={pair}
          language={language}
          unitId={unitId}
          usedReferences={usedReferences}
          resolvingImport={resolvingImport}
          onFollow={onFollow}
        />
      ))}
    </section>
  );
}

/** Stable React key for one paired import context entry. */
function importPairKey(pair: PairedImportStatement) {
  if (pair.kind === "deleted") {
    return `deleted:${pair.previous.from}:${pair.previous.to}`;
  }
  return `${pair.kind}:${pair.current.from}:${pair.current.to}`;
}

/** Renders one import statement, including before/after lines for rewrites. */
function ImportContextPair({
  pair,
  language,
  unitId,
  usedReferences,
  resolvingImport,
  onFollow,
}: {
  pair: PairedImportStatement;
  language: string;
  unitId: string;
  usedReferences: ReadonlySet<string>;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  if (pair.kind === "deleted") {
    return (
      <ImportContextStatement
        statement={pair.previous}
        language={language}
        unitId={unitId}
        tone="deleted"
        usedReferences={usedReferences}
        interactive={false}
        resolvingImport={resolvingImport}
        onFollow={onFollow}
      />
    );
  }
  return (
    <>
      {pair.previous && pair.kind === "modified" && (
        <ImportContextStatement
          statement={pair.previous}
          language={language}
          unitId={unitId}
          tone="deleted"
          usedReferences={usedReferences}
          interactive={false}
          resolvingImport={resolvingImport}
          onFollow={onFollow}
        />
      )}
      <ImportContextStatement
        statement={pair.current}
        language={language}
        unitId={unitId}
        tone={pair.kind === "unchanged" ? "context" : "added"}
        usedReferences={usedReferences}
        interactive
        resolvingImport={resolvingImport}
        onFollow={onFollow}
      />
    </>
  );
}

/** Renders a single import statement line block with optional change styling. */
function ImportContextStatement({
  statement,
  language,
  unitId,
  tone,
  usedReferences,
  interactive,
  resolvingImport,
  onFollow,
}: {
  statement: ImportStatement;
  language: string;
  unitId: string;
  tone: "context" | "added" | "deleted";
  usedReferences: ReadonlySet<string>;
  interactive: boolean;
  resolvingImport?: string;
  onFollow: (reference: ImportReference) => void;
}) {
  const highlightedLines = useHighlightedSource(statement.source, language);
  return (
    <>
      {highlightedLines.map((line, lineIndex) => {
        const lineNumber = statement.startLine + lineIndex;
        return (
          <div
            key={`${statement.from}-${tone}-${lineIndex}`}
            className={cn(
              "group grid grid-cols-[55px_1fr] border-l-2 px-4",
              tone === "added" &&
                "border-l-addition/45 bg-addition/15 hover:bg-addition/20",
              tone === "deleted" &&
                "border-l-red-400/45 bg-red-400/15 hover:bg-red-400/20",
              tone === "context" &&
                "border-transparent bg-surface-subtle/15 hover:bg-surface-subtle",
            )}
          >
            <span
              className={cn(
                "flex items-center justify-end pr-3 text-right opacity-55 select-none group-hover:opacity-80",
                tone === "added" && "text-addition opacity-80",
                tone === "deleted" &&
                  "text-red-700 opacity-80 dark:text-red-200",
                tone === "context" && "text-fog",
              )}
            >
              {lineNumber}
            </span>
            <pre
              className={cn(
                "syntax-code overflow-visible text-cloud",
                tone === "deleted" && "line-through opacity-80",
              )}
            >
              <HighlightedTokens
                tokens={line.tokens}
                renderToken={({ children, className, token }) => {
                  const reference = statement.references.find(
                    (candidate) =>
                      candidate.from - statement.from >= token.from &&
                      candidate.to - statement.from <= token.to,
                  );
                  if (!interactive || !reference) {
                    return (
                      <span
                        {...(isPeekableToken(token)
                          ? symbolPeekAttributes(token.text, lineNumber)
                          : undefined)}
                        className={cn(
                          className,
                          tone === "context" &&
                            "opacity-55 transition-opacity group-hover:opacity-80",
                        )}
                      >
                        {children}
                      </span>
                    );
                  }
                  const referenceKey = `${reference.from}:${reference.to}`;
                  const resolutionKey = `${unitId}:${referenceKey}`;
                  const used = usedReferences.has(referenceKey);
                  return (
                    <button
                      type="button"
                      aria-label={`Open ${reference.local} from ${reference.specifier}`}
                      title={
                        used
                          ? `Used by this unit · open ${reference.specifier}`
                          : `Not used by this unit · open ${reference.specifier}`
                      }
                      disabled={resolvingImport === resolutionKey}
                      onClick={() => onFollow(reference)}
                      {...symbolPeekAttributes(reference.local, lineNumber)}
                      className={cn(
                        "decoration-cyan/55 hover:bg-cyan/[.09] cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 transition",
                        className,
                        used
                          ? "text-cyan opacity-100"
                          : "opacity-55 hover:opacity-80",
                        resolvingImport === resolutionKey &&
                          "animate-pulse cursor-wait",
                      )}
                    >
                      {children}
                    </button>
                  );
                }}
              />
            </pre>
          </div>
        );
      })}
    </>
  );
}

/** Counts unique display nodes within one hierarchy branch. */
function hierarchyNodeCount(node: ReviewHierarchyNode<ReviewUnit>): number {
  return (
    1 +
    node.children.reduce((total, child) => total + hierarchyNodeCount(child), 0)
  );
}

/** Checks whether a hierarchy branch contains a review unit. */
function hierarchyContains(
  node: ReviewHierarchyNode<ReviewUnit>,
  unitId: string,
): boolean {
  return (
    node.unit.id === unitId ||
    node.children.some((child) => hierarchyContains(child, unitId))
  );
}

/** Renders dependency rows nested beneath a hierarchy concept root. */
function HierarchyDependencyRows({
  nodes,
  level,
  activeUnitId,
  onSelect,
}: {
  nodes: ReviewHierarchyNode<ReviewUnit>[];
  level: number;
  activeUnitId: string;
  onSelect: (index: number) => void;
}) {
  return nodes.map((node) => {
    const active = node.unit.id === activeUnitId;
    const fileName = node.unit.path.split("/").at(-1) ?? node.unit.path;
    return (
      <Fragment key={node.unit.id}>
        <button
          type="button"
          aria-current={active ? "step" : undefined}
          onClick={() => onSelect(node.index)}
          className={cn(
            "group relative flex w-full min-w-0 items-center gap-2.5 rounded-lg py-2 pr-2 text-left transition",
            active ? "bg-cyan/[.075]" : "hover:bg-surface-subtle",
          )}
          style={{ paddingLeft: `${12 + Math.min(level, 8) * 16}px` }}
        >
          {level > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-0 bottom-0 border-l border-line"
              style={{ left: `${18 + Math.min(level - 1, 7) * 16}px` }}
            />
          )}
          <span
            className={cn(
              "z-10 size-2 shrink-0 rounded-full border",
              node.unit.status === "signed_off"
                ? "border-lime bg-lime"
                : node.unit.status === "waiting"
                  ? "border-cyan bg-cyan/25"
                  : node.unit.status === "changed"
                    ? "border-amber-400 bg-amber-400/30"
                    : "border-line-strong bg-panel",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="text-cloud block truncate font-mono text-[10px]">
              {node.unit.name}
            </span>
            <span className="text-fog mt-0.5 block truncate text-[9px] capitalize">
              {fileName} · {node.unit.kind.replace("_", " ")} · depth{" "}
              {node.unit.depth}
            </span>
          </span>
          <ChevronRight className="text-fog size-3 shrink-0 opacity-0 transition group-hover:opacity-100" />
        </button>
        {node.children.length > 0 && (
          <HierarchyDependencyRows
            nodes={node.children}
            level={level + 1}
            activeUnitId={activeUnitId}
            onSelect={onSelect}
          />
        )}
      </Fragment>
    );
  });
}

/** Renders the compact dependency hierarchy dialog. */
export function ReviewHierarchyDialog({
  roots,
  activeUnitId,
  onSelect,
  onClose,
}: {
  roots: ReviewHierarchyNode<ReviewUnit>[];
  activeUnitId: string;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const activeRoot = roots.find((root) =>
    hierarchyContains(root, activeUnitId),
  );
  const [expandedRoots, setExpandedRoots] = useState(
    () => new Set(activeRoot ? [activeRoot.unit.id] : []),
  );
  useEffect(() => {
    /** Closes the hierarchy dialog from the keyboard. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-hierarchy-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bg-panel flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
              <GitBranch className="text-cyan size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="review-hierarchy-title"
                className="text-cloud text-sm font-medium"
              >
                Review hierarchy
              </h2>
              <p className="text-fog mt-1 text-[10px] leading-4">
                {roots.length} coherent concepts. Prerequisites are nested below
                each concept root; review proceeds from the deepest leaf upward.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close review hierarchy"
            onClick={onClose}
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 sm:p-4">
          {roots.map((root, conceptIndex) => {
            const expanded = expandedRoots.has(root.unit.id);
            const active = hierarchyContains(root, activeUnitId);
            const fileName = root.unit.path.split("/").at(-1) ?? root.unit.path;
            return (
              <section
                key={root.unit.id}
                className={cn(
                  "overflow-hidden rounded-xl border",
                  active ? "border-cyan/30 bg-cyan/[.025]" : "border-line",
                )}
              >
                <div className="flex items-center gap-1 p-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(root.index);
                      onClose();
                    }}
                    className="hover:bg-surface-subtle flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition"
                  >
                    <span className="text-cyan grid size-6 shrink-0 place-items-center rounded-md bg-cyan/10 font-mono text-[9px]">
                      {conceptIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-cloud block truncate font-mono text-[11px]">
                        {root.unit.name}
                      </span>
                      <span className="text-fog mt-0.5 block truncate text-[9px]">
                        {fileName} · {hierarchyNodeCount(root)} units
                      </span>
                    </span>
                    {active && (
                      <Badge className="border-cyan/20 bg-cyan/[.07] text-cyan">
                        Current
                      </Badge>
                    )}
                  </button>
                  {root.children.length > 0 && (
                    <button
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${root.unit.name} hierarchy`}
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedRoots((current) => {
                          const next = new Set(current);
                          if (next.has(root.unit.id)) next.delete(root.unit.id);
                          else next.add(root.unit.id);
                          return next;
                        })
                      }
                      className="text-mist hover:text-cloud grid size-9 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
                    >
                      <ChevronDown
                        className={cn(
                          "size-3.5 transition-transform",
                          !expanded && "-rotate-90",
                        )}
                      />
                    </button>
                  )}
                </div>
                {expanded && root.children.length > 0 && (
                  <div className="border-t border-line/70 px-1.5 py-1.5">
                    <HierarchyDependencyRows
                      nodes={root.children}
                      level={1}
                      activeUnitId={activeUnitId}
                      onSelect={(index) => {
                        onSelect(index);
                        onClose();
                      }}
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <footer className="text-fog flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[9px] sm:px-5">
          <span>Shared dependencies appear under their first concept.</span>
          <span className="shrink-0">Esc closes</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * Lets the reviewer choose which concept the open unit should join.
 *
 * Every eligible concept is named so the destination is explicit.
 */
export function ConceptMoveDialog({
  concepts,
  currentConceptId,
  pending,
  unitName,
  onSelect,
  onClose,
}: {
  concepts: WorkspaceData["concepts"];
  currentConceptId: string;
  pending: boolean;
  unitName: string;
  onSelect: (conceptId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    /** Closes the move dialog from the keyboard. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, pending]);
  const source = concepts.find(({ id }) => id === currentConceptId);
  const destinations = concepts.filter(({ id }) => id !== currentConceptId);
  // A concept with nothing left in it is dropped rather than kept empty, and
  // the reviewer should know that before the last member leaves.
  const emptiesSource = source?.memberIds.length === 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="concept-move-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div className="bg-panel flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
              <FolderInput className="text-cyan size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="concept-move-title"
                className="text-cloud text-sm font-medium"
              >
                Move this unit to another concept
              </h2>
              <p className="text-mist mt-1 truncate font-mono text-[11px]">
                {unitName}
              </p>
              {source && (
                <p className="text-fog mt-0.5 truncate text-[10px] leading-4">
                  Now reviewed in {source.title}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close move dialog"
            disabled={pending}
            onClick={onClose}
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
          <p className="text-fog mb-3 px-1 text-[10px] leading-4">
            Pick where it should be reviewed instead. The code under review does
            not change — only which concept you read it alongside.
          </p>
          <div className="space-y-2">
            {destinations.length === 0 ? (
              <p className="text-mist rounded-xl border border-dashed border-line p-4 text-xs leading-5">
                This review has no other concept to move the unit into. Split a
                concept first, and the pieces become destinations.
              </p>
            ) : (
              destinations.map((concept) => (
                <button
                  key={concept.id}
                  type="button"
                  disabled={pending}
                  onClick={() => onSelect(concept.id)}
                  className="hover:border-cyan/30 hover:bg-cyan/[.03] flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-cloud block truncate text-[11px]">
                      {concept.title}
                    </span>
                    <span className="text-fog mt-0.5 block truncate text-[9px]">
                      {concept.memberIds.length}{" "}
                      {concept.memberIds.length === 1 ? "unit" : "units"} ·{" "}
                      {concept.changedLineCount} changed lines in{" "}
                      {concept.fileCount}{" "}
                      {concept.fileCount === 1 ? "file" : "files"}
                    </span>
                  </span>
                  <ChevronRight className="text-mist size-3.5 shrink-0" />
                </button>
              ))
            )}
          </div>
        </div>
        <footer className="text-fog flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[9px] sm:px-5">
          <span>
            {emptiesSource
              ? "This is the last unit in its concept, so that concept is removed."
              : "Reordering a concept never removes a unit from the review."}
          </span>
          <span className="shrink-0">{pending ? "Moving…" : "Esc closes"}</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * Presents the pull request the reviewer is working through.
 *
 * ReviewDuck deliberately opens on the code rather than on the prose around
 * it, so the author's own account of the change is a click away instead of a
 * trip back to the provider. The body is provider Markdown and is rendered
 * through the same allowlist as every other untrusted provider text.
 */
export function PullRequestDetailsDialog({
  pullRequest,
  onClose,
}: {
  pullRequest: WorkspaceData["pullRequest"];
  onClose: () => void;
}) {
  useEffect(() => {
    /** Closes the details dialog from the keyboard. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const description = pullRequest.description?.trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pull-request-details-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bg-panel flex max-h-[82dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-cyan/10 grid size-9 shrink-0 place-items-center rounded-xl">
              <Info className="text-cyan size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="pull-request-details-title"
                className="text-cloud text-sm font-medium"
              >
                {pullRequest.title}
              </h2>
              <p className="text-fog mt-1 truncate text-[10px] leading-4">
                {pullRequest.repositoryOwner}/{pullRequest.repositoryName} #
                {pullRequest.number} · {providerLabel(pullRequest.provider)}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close pull request details"
            onClick={onClose}
            className="text-mist hover:text-cloud grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-surface-subtle"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
          <div className="text-fog flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px]">
            <span className="text-mist">{pullRequest.authorLogin}</span>
            <span
              role="img"
              aria-label={`${pullRequest.sourceBranch} into ${pullRequest.targetBranch}`}
              className="border-line bg-surface-subtle text-mist inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono"
            >
              <GitBranch className="text-cyan size-3" aria-hidden="true" />
              <span className="truncate">{pullRequest.sourceBranch}</span>
              <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{pullRequest.targetBranch}</span>
            </span>
          </div>
          {description ? (
            <ProviderCommentBody
              body={description}
              className="mt-4 max-w-none"
            />
          ) : (
            <p className="text-mist mt-4 rounded-xl border border-dashed border-line p-4 text-xs leading-5">
              This pull request has no description on{" "}
              {providerLabel(pullRequest.provider)}.
            </p>
          )}
        </div>
        <footer className="text-fog flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[9px] sm:px-5">
          <a
            href={pullRequest.webUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan inline-flex items-center gap-1.5 transition hover:underline"
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            Open on {providerLabel(pullRequest.provider)}
          </a>
          <span className="shrink-0">Esc closes</span>
        </footer>
      </div>
    </div>
  );
}
