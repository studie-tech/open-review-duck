import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  aiJobs,
  aiReviewFindingLocations,
  aiReviewFindings,
  aiReviewItems,
  providerConnections,
  pullRequests,
  repositories,
  reviewComments,
  reviewConceptDependencies,
  reviewConceptLayouts,
  reviewConceptMembers,
  reviewConcepts,
  reviewQueueItems,
  reviewSessions,
  reviewSnapshots,
  reviewUnitDependencies,
  reviewUnits,
  reviewWaits,
  signOffs,
  snapshotFiles,
  syncRuns,
  users,
  workflowRuns,
  workspaceMembers,
} from "@/drizzle/schema";
import { conceptStatusFromMembers } from "~/lib/concept-progress";
import {
  findImportedDeclarationLine,
  findImportTargetUnit,
  importPathCandidates,
} from "~/lib/import-navigation";
import { buildProviderLifecycle } from "~/lib/provider-lifecycle";
import {
  definitionIsWhereTheNameWasRead,
  localDefinitionForPeek,
  SYMBOL_PEEK_MAXIMUM_LINES,
  sameFileDeclarationPeek,
} from "~/lib/symbol-peek";
import { managedAiPlanTier } from "~/server/ai/plan";
import {
  proposeSemanticConceptLayout,
  SEMANTIC_CLUSTER_TIMED_OUT,
  SEMANTIC_CLUSTER_TOO_LARGE,
} from "~/server/ai/semantic-clustering";
import { CURRENT_AI_AGENT_VERSION } from "~/server/ai/service";
import {
  MAX_CONCEPT_CHANGED_LINES,
  MAX_CONCEPT_FILES,
} from "~/server/analysis/concepts";
import { analyzeFiles } from "~/server/analysis/engine";
import { sha256 } from "~/server/analysis/hash";
import {
  importReferenceForLocal,
  parseImportReferences,
} from "~/server/analysis/imports";
import type { db as database } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";
import { providerForConnection } from "~/server/providers/credentials";
import {
  ProviderError,
  type ProviderName,
  type ProviderPullRequestLifecycle,
  type PullRequestProvider,
} from "~/server/providers/types";
import {
  claimCommentForPublicationRetry,
  findEquivalentUserComment,
  providerCommentBody,
  publicationAttemptKey,
  publishedThreadForComment,
  rewrittenProviderCommentBody,
  visibleProviderCommentBody,
} from "~/server/review/comments";
import { reviewCompletionCounts } from "~/server/review/completion";
import { deepReviewCoverage } from "~/server/review/deep/finalize";
import { DEEP_REVIEW_SURVEY_ITEM_PATH } from "~/server/review/deep/survey";
import {
  removePullRequestFromQueue,
  restorePullRequestToQueue,
} from "~/server/review/queue";
import {
  assignProviderThreadsToUnits,
  hasNewProviderActivity,
  providerActivityForUnit,
} from "~/server/review/waiting";
import { enforceRateLimit } from "~/server/security/rate-limit";
import { openVaultSecret } from "~/server/security/vault";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import {
  connectionUpdateResolvesSyncFailure,
  persistedSyncErrorMessage,
  providerSyncErrorMessage,
} from "~/server/sync/error";
import {
  cancelWorkflowRun,
  startPullRequestSync,
} from "~/server/workflows/service";
import {
  editReviewThreadCommentSchema,
  importTargetSchema,
  improveConceptGroupingSchema,
  providerReviewDecisionSchema,
  publishReviewCommentSchema,
  releaseReviewWaitsSchema,
  replacePersonalConceptLayoutSchema,
  replyToReviewThreadSchema,
  resolveReviewThreadSchema,
  reviewFileActionSchema,
  reviewThreadCommentSchema,
  reviewThreadSchema,
  reviewUnitSchema,
  reviewWorkspaceSchema,
  type SignOffInput,
  signOffBatchSchema,
  signOffConceptSchema,
  signOffSchema,
  symbolDefinitionSchema,
  syncPullRequestSchema,
  unreviewConceptSchema,
  unreviewFileSchema,
  unreviewSchema,
} from "~/validators/review";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/** Builds the workspace-scoped query used to authorize pull-request access. */
const accessiblePullRequest = (userId: string, pullRequestId: string) =>
  and(eq(pullRequests.id, pullRequestId), eq(workspaceMembers.userId, userId));

/**
 * Authorizes and rate-limits one management action on a provider conversation.
 *
 * Resolving, editing and deleting all reach the same provider through the same
 * unit, so they share one gate rather than each restating the lookup.
 */
async function reviewThreadScope(
  db: typeof database,
  userId: string,
  input: { unitId: string },
  action: string,
) {
  // Two gates, as everywhere else provider work is reached from: what one
  // reviewer may ask for at all, and what they may ask of one repository.
  // Only the second one needs the lookup, so the first shares its round trip.
  const [scope] = await Promise.all([
    providerScopeForUnit(db, userId, input.unitId),
    enforceRateLimit(db, `${action}:${userId}`, 60, 60_000),
  ]);
  await enforceRateLimit(
    db,
    `${action}-resource:${userId}:${scope.pullRequestId}`,
    30,
    60_000,
  );
  return { provider: await providerForConnection(db, scope.connection), scope };
}

/**
 * Finds the named conversation among those anchored to the reviewed unit.
 *
 * A conversation the unit does not own is not the reviewer's to manage from
 * here, so an id that points elsewhere reads as missing rather than as an
 * action on some other part of the pull request.
 */
async function attachedProviderThread(
  provider: PullRequestProvider,
  scope: Awaited<ReturnType<typeof providerScopeForUnit>>,
  input: { threadExternalId: string },
) {
  const thread = (
    await provider.listInlineCommentThreads(
      scope.repositoryExternalId,
      scope.pullRequestNumber,
    )
  ).find(
    (candidate) =>
      candidate.externalId === input.threadExternalId &&
      candidate.path === scope.path &&
      reviewUnitContainsLine(scope, candidate.line),
  );
  if (!thread) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        "This provider conversation is no longer attached to the current review unit",
    });
  }
  return thread;
}

/** Presents a failed conversation action in the provider's own terms. */
function providerThreadError(provider: ProviderName, cause: unknown) {
  if (cause instanceof TRPCError) return cause;
  return new TRPCError({
    code: "BAD_REQUEST",
    message: providerSyncErrorMessage(provider, cause),
    cause,
  });
}

/**
 * Names the ledger row one comment of a conversation was published as.
 *
 * `publishInlineComment` opens a conversation and returns the identifier the
 * provider gives that conversation: a discussion on GitLab, a thread on Azure
 * DevOps, and the root comment on GitHub, which is what GitHub keys a thread
 * by. So the ledger is keyed by conversation, and only the comment a
 * conversation hangs from is ever a row of it — a reply is keyed by its own
 * identifier instead.
 */
function publishedCommentId(
  thread: { comments: { externalId: string }[]; externalId: string },
  commentExternalId: string,
) {
  return thread.comments[0]?.externalId === commentExternalId
    ? thread.externalId
    : undefined;
}

/**
 * Names the reviewer ReviewDuck published one provider comment for.
 *
 * One workspace connection speaks for every member, so the provider cannot
 * say which of them wrote a comment and will let any of them change it. What
 * ReviewDuck published it knows the author of, and that is what it protects:
 * a root comment through the conversation it opened, a reply through its own
 * identifier. A comment ReviewDuck did not publish — a bot's, or one written
 * in the provider's own interface — has no recorded author and stays open to
 * whoever the provider itself would allow.
 */
export async function publishedCommentAuthor(
  db: typeof database,
  unitId: string,
  thread: { comments: { externalId: string }[]; externalId: string },
  commentExternalId: string,
) {
  const conversationId = publishedCommentId(thread, commentExternalId);
  const [owned] = await db
    .select({ userId: reviewComments.userId })
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.unitId, unitId),
        eq(reviewComments.status, "published"),
        conversationId
          ? or(
              eq(reviewComments.providerCommentExternalId, commentExternalId),
              eq(reviewComments.providerExternalId, conversationId),
            )
          : eq(reviewComments.providerCommentExternalId, commentExternalId),
      ),
    )
    .limit(1);
  return owned?.userId;
}

/**
 * Refuses one reviewer's change to a comment ReviewDuck published for another.
 *
 * Editing puts words in their mouth and deleting takes their feedback away,
 * and the provider records neither as anyone but the shared connection.
 */
export async function assertCommentIsTheReviewersToChange(
  db: typeof database,
  userId: string,
  unitId: string,
  thread: { comments: { externalId: string }[]; externalId: string },
  commentExternalId: string,
) {
  const author = await publishedCommentAuthor(
    db,
    unitId,
    thread,
    commentExternalId,
  );
  if (author && author !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Another reviewer published this comment through ReviewDuck. Only they can change it.",
    });
  }
}

/**
 * Drops the local record of comments that no longer exist at the provider.
 *
 * The ledger of what ReviewDuck published is what marks an AI finding as
 * posted and hides a duplicate of the provider conversation, so a deleted
 * comment has to leave it or the reviewer keeps being told it is still there.
 */
async function forgetPublishedComments(
  db: typeof database,
  unitId: string,
  gone: {
    commentIds?: readonly (string | undefined)[];
    conversationIds?: readonly (string | undefined)[];
  },
) {
  const conversationIds = [...new Set(gone.conversationIds ?? [])].filter(
    (id): id is string => Boolean(id),
  );
  const commentIds = [...new Set(gone.commentIds ?? [])].filter(
    (id): id is string => Boolean(id),
  );
  // A root comment is recorded against the conversation it opened and a reply
  // against itself, so both keys are given up together.
  const named = [
    ...(conversationIds.length
      ? [inArray(reviewComments.providerExternalId, conversationIds)]
      : []),
    ...(commentIds.length
      ? [inArray(reviewComments.providerCommentExternalId, commentIds)]
      : []),
  ];
  if (named.length === 0) return;
  await db
    .delete(reviewComments)
    .where(and(eq(reviewComments.unitId, unitId), or(...named)));
}

type SymbolDefinitionInput = z.infer<typeof symbolDefinitionSchema>;

/** Shapes one declaration as the definition card the reviewer reads. */
function symbolDefinitionOf(
  unit: {
    endLine: number;
    kind: string;
    language: string;
    name: string;
    path: string;
    signature?: string | null;
    source: string;
    startLine: number;
  },
  focusLine: number | undefined,
  unitId?: string,
) {
  const lines = unit.source.split("\n");
  return {
    kind: "definition" as const,
    endLine: unit.startLine + Math.max(0, lines.length - 1),
    focusLine: focusLine ?? unit.startLine,
    language: unit.language,
    name: unit.name,
    path: unit.path,
    signature: unit.signature ?? undefined,
    source: unit.source,
    startLine: unit.startLine,
    unitId,
    unitKind: unit.kind,
  };
}

/**
 * Looks the name up among the declarations the snapshot already stores.
 *
 * The reviewed file's own declarations answer first, because a name used in a
 * file usually belongs to it; a name declared exactly once anywhere else in
 * the change answers next, and an ambiguous one is left to the file parse
 * rather than guessed at.
 */
async function declaredSymbolInSnapshot(
  db: typeof database,
  snapshotId: string,
  input: SymbolDefinitionInput,
) {
  const matches = await db.query.reviewUnits.findMany({
    where: and(
      eq(reviewUnits.snapshotId, snapshotId),
      eq(reviewUnits.name, input.symbol),
      notInArray(reviewUnits.kind, ["file", "module", "binary"]),
    ),
    orderBy: [reviewUnits.reviewOrder],
    limit: 25,
  });
  const own = matches.filter(({ path }) => path === input.sourcePath);
  const chosen = own[0] ?? (matches.length === 1 ? matches[0] : undefined);
  if (!chosen) return undefined;
  // Every candidate had to be read to know which one answers; only the one
  // that does needs its source pulled out of storage.
  const [target] = await hydrateReviewUnits(db, [chosen]);
  return target
    ? symbolDefinitionOf(target, target.startLine, target.id)
    : undefined;
}

/**
 * How many parsed files the symbol lookup keeps declarations for.
 *
 * Each entry holds the declarations of one file at one immutable snapshot
 * revision. One reviewer moves between a handful of files, but the ring is
 * shared by everyone an instance is serving, so it is sized for several of
 * them at once rather than for one: too small and concurrent reviewers evict
 * each other's files and pay for the parse again on the next name.
 */
const SYMBOL_FILE_CACHE_LIMIT = 64;

/**
 * How much source the parse cache may hold across every file it remembers.
 *
 * Entry count alone bounds nothing useful: sixty-four files at the read limit
 * is far more memory than sixty-four small ones, and the ring is shared by
 * everyone an instance serves.
 */
const SYMBOL_FILE_CACHE_CHARACTERS = 2_000_000;

/**
 * How many candidate paths of each shape one name may read from the provider.
 *
 * A specifier without an extension stands for a file under any of its
 * language's extensions and for a directory's index under each of them, and
 * every candidate that misses is a request. The two shapes are bounded
 * separately so a bound can never put a directory import out of reach.
 */
const MAXIMUM_IMPORT_READS = 8;

const DIRECTORY_IMPORT = /\/(?:index\.[^./]+|__init__\.py)$/;

interface ParsedSymbolFile {
  declarations: Map<string, ReturnType<typeof symbolDefinitionOf>>;
  imports: ReturnType<typeof parseImportReferences>;
  language: string;
  source: string;
}

/**
 * Narrows a whole file to the lines a definition card can actually show.
 *
 * A module answers when no declaration in it does, and the file behind it may
 * run to the read limit while the card shows under twenty lines. Sending the
 * rest would spend the payload of every hover on lines nobody reads.
 */
function windowedModuleSource<
  Unit extends { source: string; startLine: number },
>(unit: Unit, focusLine: number | undefined) {
  const lines = unit.source.split("\n");
  const lead = 2;
  const offset = Math.min(
    Math.max(0, (focusLine ?? unit.startLine) - unit.startLine - lead),
    Math.max(0, lines.length - 1),
  );
  return {
    ...unit,
    source: lines
      .slice(offset, offset + SYMBOL_PEEK_MAXIMUM_LINES + lead * 2)
      .join("\n"),
    startLine: unit.startLine + offset,
  };
}

const symbolFileCache = new Map<string, ParsedSymbolFile>();
const symbolFileCacheWeights = new Map<string, number>();
let symbolFileCacheCharacters = 0;

/**
 * Parses the whole reviewed file to find a declaration the diff left out.
 *
 * Only changed declarations become review units, so a helper the reviewer is
 * calling is often present in the file and absent from the snapshot's units.
 * The file's stored source is already at hand, so this needs no provider call.
 *
 * Peek fires on hover, and one parse answers every name in the file, so the
 * declarations and imports are kept against the snapshot revision they came
 * from instead of running the analysis again for the next name on the same
 * line.
 */
async function parsedSymbolFile(
  db: typeof database,
  snapshotId: string,
  input: SymbolDefinitionInput,
) {
  const key = `${snapshotId}\0${input.sourcePath}`;
  const cached = symbolFileCache.get(key);
  if (cached) {
    // Re-inserting keeps the files a reviewer is moving between at the end of
    // the ring, so the one evicted next is the one longest unused.
    symbolFileCache.delete(key);
    symbolFileCache.set(key, cached);
    return cached;
  }

  const [file] = await hydrateReviewUnits(
    db,
    await db.query.reviewUnits.findMany({
      where: and(
        eq(reviewUnits.snapshotId, snapshotId),
        eq(reviewUnits.path, input.sourcePath),
        eq(reviewUnits.kind, "file"),
      ),
      limit: 1,
    }),
  );
  if (!file?.source) return undefined;
  const declarations: ParsedSymbolFile["declarations"] = new Map();
  for (const unit of analyzeFiles([
    {
      path: input.sourcePath,
      content: file.source,
      changeType: "modified",
      reviewWholeFile: true,
    },
  ]).units) {
    if (unit.kind === "file" || unit.kind === "module") continue;
    // The first declaration of a name wins, the same way a single `find` did.
    if (!declarations.has(unit.name)) {
      declarations.set(unit.name, symbolDefinitionOf(unit, unit.startLine));
    }
  }
  // Two hovers on the same file can both miss while the first is still
  // reading it, and both arrive here. The entry they overwrite has to leave
  // the total, or it keeps a surplus that eventually empties the ring on
  // every insert and quietly costs a parse per hover.
  symbolFileCacheCharacters -= symbolFileCacheWeights.get(key) ?? 0;
  const parsed = {
    declarations,
    imports: parseImportReferences(file.source, input.sourceLanguage),
    language: input.sourceLanguage,
    source: file.source,
  } satisfies ParsedSymbolFile;
  symbolFileCache.set(key, parsed);
  symbolFileCacheCharacters += file.source.length;
  symbolFileCacheWeights.set(key, file.source.length);
  while (
    symbolFileCache.size > SYMBOL_FILE_CACHE_LIMIT ||
    symbolFileCacheCharacters > SYMBOL_FILE_CACHE_CHARACTERS
  ) {
    const oldest = symbolFileCache.keys().next().value;
    if (oldest === undefined) break;
    symbolFileCache.delete(oldest);
    symbolFileCacheCharacters -= symbolFileCacheWeights.get(oldest) ?? 0;
    symbolFileCacheWeights.delete(oldest);
  }
  return parsed;
}

/**
 * Follows the file's own import of a name into the file that declares it.
 *
 * Reached only once the change itself has nothing to say about the name, and
 * only when the reviewer's file names where it came from, so the one provider
 * read this can cost is spent on a name that has no cheaper answer.
 */
async function importedSymbolDefinition(
  db: typeof database,
  userId: string,
  snapshot: { headSha: string; id: string },
  scope: {
    connection: typeof providerConnections.$inferSelect;
    pullRequestId: string;
    repositoryExternalId: string;
  },
  input: SymbolDefinitionInput,
) {
  if (!input.specifier) return undefined;
  const imported = input.imported ?? input.symbol;
  const candidates = importPathCandidates(
    input.sourcePath,
    input.specifier,
    input.sourceLanguage,
  );
  if (candidates.length === 0) return undefined;

  const stored = await hydrateReviewUnits(
    db,
    await db.query.reviewUnits.findMany({
      where: and(
        eq(reviewUnits.snapshotId, snapshot.id),
        inArray(reviewUnits.path, candidates),
        eq(reviewUnits.name, imported),
      ),
      orderBy: [reviewUnits.reviewOrder],
      limit: 1,
    }),
  );
  const [known] = stored;
  if (known) return symbolDefinitionOf(known, known.startLine, known.id);

  // Only now does a hover become provider traffic, and one unresolved name can
  // try every extension the specifier could carry. The repository pays for that
  // fan-out, so it is gated per pull request the way every other
  // provider-backed procedure in this router is.
  await enforceRateLimit(
    db,
    `review-symbol-resource:${userId}:${scope.pullRequestId}`,
    30,
    60_000,
  );
  const provider = await providerForConnection(db, scope.connection);
  // A file answers before the directory of the same name, the way the runtime
  // resolves it, so the two are bounded apart rather than as one list: a flat
  // bound would spend itself on extensions and never reach an index at all.
  const reads = [
    ...candidates
      .filter((path) => !DIRECTORY_IMPORT.test(path))
      .slice(0, MAXIMUM_IMPORT_READS),
    ...candidates
      .filter((path) => DIRECTORY_IMPORT.test(path))
      .slice(0, MAXIMUM_IMPORT_READS),
  ];
  for (const path of reads) {
    let content: string | undefined;
    try {
      content = await provider.getFileContent(
        scope.repositoryExternalId,
        path,
        snapshot.headSha,
        150_000,
      );
    } catch (cause) {
      if (cause instanceof ProviderError && cause.status === 404) continue;
      // A peek must not break the review, so a refused or rate-limited
      // provider is answered softly — but it is not the same answer as "this
      // name has no declaration", and an expired token has to be diagnosable.
      console.error("Symbol definition lookup could not read the source", {
        path,
        pullRequestId: scope.pullRequestId,
        status: cause instanceof ProviderError ? cause.status : undefined,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return { kind: "unresolved" as const, reason: "unavailable" as const };
    }
    if (content === undefined) {
      return { kind: "unresolved" as const, reason: "too_large" as const };
    }
    const analyzed = analyzeFiles([
      { path, content, changeType: "modified" },
    ]).units;
    const declaration = analyzed.find(
      (unit) =>
        unit.name === imported &&
        unit.kind !== "file" &&
        unit.kind !== "module",
    );
    if (declaration) {
      return symbolDefinitionOf(declaration, declaration.startLine);
    }
    const module = analyzed.find((unit) => unit.kind === "file");
    if (module) {
      const focusLine = findImportedDeclarationLine(
        module.source,
        imported,
        module.language,
        module.startLine,
      );
      const windowed = windowedModuleSource(module, focusLine);
      return symbolDefinitionOf(windowed, focusLine ?? windowed.startLine);
    }
  }
  return undefined;
}

/** Checks one provider-side line against a unit's disjoint review ranges. */
function reviewUnitContainsLine(
  unit: Pick<
    typeof reviewUnits.$inferSelect,
    "changeType" | "endLine" | "relatedRanges" | "startLine"
  >,
  line: number,
) {
  const ranges =
    unit.relatedRanges?.flatMap((range) => {
      const start =
        unit.changeType === "deleted"
          ? range.previousStartLine
          : range.startLine;
      const end =
        unit.changeType === "deleted" ? range.previousEndLine : range.endLine;
      return start !== undefined && end !== undefined ? [{ start, end }] : [];
    }) ?? [];
  return ranges.length > 0
    ? ranges.some(({ start, end }) => line >= start && line <= end)
    : line >= unit.startLine && line <= unit.endLine;
}

/** Resolves and authorizes the provider context for one review unit. */
async function providerScopeForUnit(
  db: typeof database,
  userId: string,
  unitId: string,
  staleRevisionMessage = "Synchronize the pull request before changing its conversations",
) {
  const [scope] = await db
    .select({
      unitId: reviewUnits.id,
      path: reviewUnits.path,
      startLine: reviewUnits.startLine,
      endLine: reviewUnits.endLine,
      relatedRanges: reviewUnits.relatedRanges,
      changeType: reviewUnits.changeType,
      snapshotId: reviewUnits.snapshotId,
      snapshotHeadSha: reviewSnapshots.headSha,
      snapshotBaseSha: reviewSnapshots.baseSha,
      pullRequestId: pullRequests.id,
      pullRequestNumber: pullRequests.number,
      headSha: pullRequests.headSha,
      baseSha: pullRequests.baseSha,
      repositoryExternalId: repositories.externalId,
      connection: providerConnections,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(and(eq(reviewUnits.id, unitId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
  if (
    scope.snapshotHeadSha !== scope.headSha ||
    scope.snapshotBaseSha !== scope.baseSha
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: staleRevisionMessage,
    });
  }
  return scope;
}

/** Resolves the authorized provider and latest snapshot for one pull request. */
async function providerScopeForPullRequest(
  db: typeof database,
  userId: string,
  pullRequestId: string,
) {
  const [scope] = await db
    .select({
      pullRequestId: pullRequests.id,
      pullRequestNumber: pullRequests.number,
      pullRequestState: pullRequests.state,
      headSha: pullRequests.headSha,
      baseSha: pullRequests.baseSha,
      repositoryExternalId: repositories.externalId,
      connection: providerConnections,
    })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(accessiblePullRequest(userId, pullRequestId))
    .limit(1);
  if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
  const snapshot = await db.query.reviewSnapshots.findFirst({
    where: eq(reviewSnapshots.pullRequestId, scope.pullRequestId),
    orderBy: [desc(reviewSnapshots.version)],
  });
  return { ...scope, snapshot };
}

/** Converts a live provider failure into a safe user-facing review message. */
function providerOperationError(
  provider: ProviderName,
  cause: unknown,
  operation: "review" | "lifecycle" | "merge",
) {
  if (cause instanceof TRPCError) return cause;
  const label =
    provider === "azure_devops"
      ? "Azure DevOps"
      : provider === "gitlab"
        ? "GitLab"
        : "GitHub";
  const permissionDenied =
    cause instanceof ProviderError &&
    (cause.status === 401 || cause.status === 403);
  const messages = {
    review: {
      forbidden: `${label} did not allow this review decision. Reconnect it with code-review write permission and confirm that you are an eligible reviewer.`,
      failed: `${label} review state could not be synchronized`,
    },
    lifecycle: {
      forbidden: `${label} did not allow reading checks and merge state. Reconnect it with permission to view pipelines.`,
      failed: `${label} checks and merge state could not be synchronized`,
    },
    merge: {
      forbidden: `${label} did not allow merging this pull request. Reconnect it with merge permission, or finish the merge on ${label}.`,
      failed: `${label} could not merge this pull request`,
    },
  }[operation];
  return new TRPCError({
    code: permissionDenied ? "FORBIDDEN" : "BAD_GATEWAY",
    message: permissionDenied ? messages.forbidden : messages.failed,
    cause,
  });
}

/** Gates merge on the exact revision the reviewer just finished. */
function scopedProviderLifecycle(
  scope: {
    connection: { provider: ProviderName };
    headSha: string;
    baseSha: string;
    snapshot?: { headSha: string; baseSha: string } | null;
  },
  lifecycle: ProviderPullRequestLifecycle,
  remote: { headSha: string; baseSha: string },
) {
  const revisionCurrent =
    remote.headSha === scope.headSha &&
    remote.baseSha === scope.baseSha &&
    scope.snapshot?.headSha === scope.headSha &&
    scope.snapshot?.baseSha === scope.baseSha;
  return {
    ...lifecycle,
    provider: scope.connection.provider,
    revisionCurrent,
    syncedAt: new Date(),
    canMerge: revisionCurrent && lifecycle.canMerge,
    mergeBlockedReason: revisionCurrent
      ? lifecycle.mergeBlockedReason
      : "The provider has a newer revision. Synchronize this pull request before merging.",
  };
}

/**
 * The finding states a reviewer is shown, discards included.
 *
 * `submitted` is pre-validation and `merged`/`dropped` are collapsed duplicates,
 * so neither is a claim anyone still makes. The anchoring gate failures and a
 * refutation are: they are retained as rows precisely so a discard stays
 * auditable, and hiding them here would make one indistinguishable from a
 * finding the run never reported.
 */
const SURFACED_DEEP_REVIEW_FINDING_STATES = [
  "anchored",
  "unanchored",
  "out_of_scope",
  "ungrounded",
  "refuted",
] as const;

interface DeepReviewFindingContent {
  title: string;
  body: string;
  existingCode: string;
  suggestionCode?: string;
}

/** Reads a sealed finding payload, tolerating anything that is not our shape. */
function parseDeepReviewFindingContent(
  payload: string,
): DeepReviewFindingContent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return {
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      existingCode:
        typeof record.existingCode === "string" ? record.existingCode : "",
      suggestionCode:
        typeof record.suggestionCode === "string"
          ? record.suggestionCode
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Opens one finding's sealed content, returning null when it cannot be read.
 *
 * A single unreadable payload must not take the whole run's findings with it,
 * so the failure is reported per row and the reviewer still sees the anchor.
 */
async function openDeepReviewFindingContent(finding: {
  id: string;
  workspaceId: string;
  encryptedContent: string;
}): Promise<DeepReviewFindingContent | null> {
  try {
    return parseDeepReviewFindingContent(
      await openVaultSecret(
        {
          workspaceId: finding.workspaceId,
          recordId: finding.id,
          provider: "ai-review-finding",
        },
        finding.encryptedContent,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Reports whether a finding still names a line a comment could be attached to.
 *
 * `review_comment.unitId` and `review_comment.line` are both not null, so an
 * unanchored, out-of-scope, ungrounded or refuted finding is structurally
 * unpublishable. The read path says so once, here, rather than leaving every
 * caller to rediscover it against a failing insert.
 */
function isDeepReviewFindingPublishable<
  T extends {
    state: string;
    verdict: string | null;
    path: string | null;
    startLine: number | null;
    unitId: string | null;
  },
>(
  finding: T,
): finding is T & { path: string; startLine: number; unitId: string } {
  return (
    finding.state === "anchored" &&
    finding.verdict !== "refuted" &&
    finding.path !== null &&
    finding.startLine !== null &&
    finding.unitId !== null
  );
}

/** Sorts findings by their frozen rank, leaving unranked rows at the end. */
function compareDeepReviewFindings(
  left: { id: string; orderIndex: number | null },
  right: { id: string; orderIndex: number | null },
): number {
  if (left.orderIndex !== right.orderIndex) {
    if (left.orderIndex === null) return 1;
    if (right.orderIndex === null) return -1;
    return left.orderIndex - right.orderIndex;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Assembles the surfaced findings and sealed coverage of one deep-review run.
 *
 * Every row below the run is reached through `ai_review_item.parentJobId`, so
 * the caller authorizes the parent job once and nothing here needs a scope
 * check of its own. Exported for its own tests, which is why it takes the job
 * row rather than looking it up.
 */
export async function deepReviewRunPayload(
  db: typeof database,
  job: Pick<
    typeof aiJobs.$inferSelect,
    | "completedAt"
    | "completionReason"
    | "createdAt"
    | "deepReviewTerminalState"
    | "error"
    | "id"
    | "runFailureClass"
    | "status"
  >,
) {
  // `review_comment` has no column for a finding id: publication is keyed on
  // (aiJobId, aiFindingIndex), and the deep-review path writes the run-wide
  // `orderIndex` into that column. Reading it for the whole run is what lets a
  // findings list tell the truth about every file at once; the per-unit
  // discussion read can only answer for the unit that happens to be open. It
  // keys off the job alone, so it rides along with the item read.
  const [items, publishedComments] = await Promise.all([
    db.query.aiReviewItems.findMany({
      columns: {
        id: true,
        path: true,
        changeType: true,
        changedLineCount: true,
        state: true,
        failureClass: true,
        reason: true,
      },
      where: eq(aiReviewItems.parentJobId, job.id),
    }),
    db.query.reviewComments.findMany({
      columns: { aiFindingIndex: true },
      where: and(
        eq(reviewComments.aiJobId, job.id),
        eq(reviewComments.status, "published"),
      ),
    }),
  ]);
  const findingRows =
    items.length === 0
      ? []
      : await db.query.aiReviewFindings.findMany({
          where: and(
            inArray(
              aiReviewFindings.itemId,
              items.map((item) => item.id),
            ),
            inArray(aiReviewFindings.state, [
              ...SURFACED_DEEP_REVIEW_FINDING_STATES,
            ]),
          ),
        });
  const locationRows =
    findingRows.length === 0
      ? []
      : await db.query.aiReviewFindingLocations.findMany({
          columns: {
            findingId: true,
            path: true,
            anchorTier: true,
            anchorSide: true,
            startLine: true,
            endLine: true,
          },
          where: inArray(
            aiReviewFindingLocations.findingId,
            findingRows.map((finding) => finding.id),
          ),
          // The client holds an open location by its index in this array, so
          // the order has to be the model's rather than the heap's.
          orderBy: [aiReviewFindingLocations.position],
        });

  const findings = await Promise.all(
    [...findingRows].sort(compareDeepReviewFindings).map(async (finding) => {
      // A payload the vault refuses is reported as an empty finding rather
      // than dropped: a discard the reader cannot see is indistinguishable
      // from a finding the run never made.
      const content = await openDeepReviewFindingContent(finding);
      return {
        id: finding.id,
        orderIndex: finding.orderIndex,
        severity: finding.severity,
        category: finding.category,
        state: finding.state,
        verdict: finding.verdict,
        verdictReason: finding.verdictReason,
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
        anchorTier: finding.anchorTier,
        anchorSide: finding.anchorSide,
        anchorAmbiguous: finding.anchorAmbiguous,
        unitId: finding.unitId,
        publishable: isDeepReviewFindingPublishable(finding),
        contentAvailable: content !== null,
        title: content?.title ?? "",
        body: content?.body ?? "",
        existingCode: content?.existingCode ?? "",
        suggestionCode: content?.suggestionCode ?? null,
        locations: locationRows
          .filter((location) => location.findingId === finding.id)
          .map(({ findingId: _findingId, ...location }) => location),
      };
    }),
  );

  const publishedRanks = new Set(
    publishedComments.flatMap((comment) =>
      comment.aiFindingIndex === null ? [] : [comment.aiFindingIndex],
    ),
  );
  const publishedFindingIds = findings
    .filter(
      (finding) =>
        finding.orderIndex !== null && publishedRanks.has(finding.orderIndex),
    )
    .map(({ id }) => id);

  return {
    jobId: job.id,
    status: job.status,
    terminalState: job.deepReviewTerminalState,
    runFailureClass: job.runFailureClass,
    completionReason: job.completionReason,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    coverage: deepReviewCoverage(items),
    items: items
      .map((item) => ({
        ...item,
        // The survey's coverage row names no real file, so a reviewer reading
        // a file list is told which entry is not one.
        kind:
          item.path === DEEP_REVIEW_SURVEY_ITEM_PATH
            ? ("survey" as const)
            : ("file" as const),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
        return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
      }),
    findings,
    publishedFindingIds,
  };
}

/**
 * Resolves the one deep-review finding a publish request may turn into a
 * comment, refusing anything that no longer describes the selected line.
 *
 * The caller's job lookup is what authorizes this: the finding row carries no
 * reviewer of its own, so it is admitted only by belonging to that job's sealed
 * plan. Everything checked here is freshness, not access. Exported for its own
 * tests, which is why it takes the parent job id rather than resolving it.
 */
export async function deepReviewFindingForPublication(
  db: typeof database,
  input: { findingId: string; parentJobId: string; path: string; line: number },
) {
  const finding = await db.query.aiReviewFindings.findFirst({
    where: eq(aiReviewFindings.id, input.findingId),
  });
  const item = finding
    ? await db.query.aiReviewItems.findFirst({
        columns: { parentJobId: true },
        where: eq(aiReviewItems.id, finding.itemId),
      })
    : undefined;
  if (!finding || item?.parentJobId !== input.parentJobId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This AI finding does not belong to the selected review",
    });
  }
  if (!isDeepReviewFindingPublishable(finding)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This AI finding is not anchored to a line of the pull request, so it can only be read in ReviewDuck",
    });
  }
  if (finding.path !== input.path || finding.startLine !== input.line) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This AI finding no longer matches the selected code",
    });
  }
  // `review_comment` has no finding-id column. Its (aiJobId, aiFindingIndex)
  // key therefore uses the run-wide order frozen at finalize.
  const orderIndex = finding.orderIndex;
  if (orderIndex === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This deep review has not finished ranking its findings yet",
    });
  }
  const content = await openDeepReviewFindingContent(finding);
  if (!content) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This AI finding could not be read back for publication",
    });
  }
  return { body: `**${content.title}**\n\n${content.body}`, orderIndex };
}

type ReviewTransaction = Parameters<
  Parameters<(typeof database)["transaction"]>[0]
>[0];

/** Loads one current-revision snapshot file the caller is allowed to act on. */
async function currentSnapshotFileForMember(
  tx: ReviewTransaction,
  userId: string,
  snapshotFileId: string,
) {
  const [file] = await tx
    .select({
      id: snapshotFiles.id,
      snapshotId: snapshotFiles.snapshotId,
      pullRequestId: pullRequests.id,
    })
    .from(snapshotFiles)
    .innerJoin(
      reviewSnapshots,
      eq(snapshotFiles.snapshotId, reviewSnapshots.id),
    )
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(snapshotFiles.id, snapshotFileId),
        eq(reviewSnapshots.headSha, pullRequests.headSha),
        eq(reviewSnapshots.baseSha, pullRequests.baseSha),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  return file;
}

interface PersistedSignOff {
  added: boolean;
  experience: number;
  input: SignOffInput;
  pullRequestId: string;
  signOff: typeof signOffs.$inferSelect;
  snapshotId: string;
}

type SignOffOutcome =
  | { ok: true; write: PersistedSignOff }
  | { code: "CONFLICT" | "NOT_FOUND"; message?: string; ok: false };

/** Builds a lookup key from an identifier and the revision it belongs to. */
function revisionKey(owner: string, revision: string) {
  return `${owner}:${revision}`;
}

/**
 * Serializes every personal-layout writer for one reviewer on one snapshot.
 * Sign-off can clone a shared baseline into a personal layout, so it has to
 * take the same key that replacePersonalConceptLayout does or the two can race
 * onto the (snapshotId, userId) unique index.
 */
async function lockConceptLayoutScope(
  tx: ReviewTransaction,
  userId: string,
  snapshotId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`review-concept-layout:${snapshotId}:${userId}`}))`,
  );
}

/** Resolves the snapshot behind one layout before its scope is locked. */
async function conceptLayoutSnapshotId(
  tx: ReviewTransaction,
  layoutId: string,
) {
  const [layout] = await tx
    .select({ snapshotId: reviewConceptLayouts.snapshotId })
    .from(reviewConceptLayouts)
    .where(eq(reviewConceptLayouts.id, layoutId))
    .limit(1);
  if (!layout) throw new TRPCError({ code: "NOT_FOUND" });
  return layout.snapshotId;
}

/**
 * Rejects a snapshot the pull request has already moved past.
 *
 * Resolving a concept silently requires the same revision, so asking first
 * turns the "no such concept" that a stale workspace would otherwise get into
 * the one instruction that resolves it.
 */
async function assertSnapshotIsCurrent(
  tx: ReviewTransaction,
  snapshotId: string,
  message: string,
) {
  const [revision] = await tx
    .select({
      snapshotHeadSha: reviewSnapshots.headSha,
      snapshotBaseSha: reviewSnapshots.baseSha,
      headSha: pullRequests.headSha,
      baseSha: pullRequests.baseSha,
    })
    .from(reviewSnapshots)
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .where(eq(reviewSnapshots.id, snapshotId))
    .limit(1);
  if (!revision) throw new TRPCError({ code: "NOT_FOUND" });
  if (
    revision.snapshotHeadSha !== revision.headSha ||
    revision.snapshotBaseSha !== revision.baseSha
  ) {
    throw new TRPCError({ code: "CONFLICT", message });
  }
}

/** Resolves one concept only when it belongs to the reviewer's active layout. */
async function conceptMembersForMutation(
  tx: ReviewTransaction,
  userId: string,
  input: { conceptId: string; layoutId: string; layoutVersion: number },
) {
  const [candidate] = await tx
    .select({
      conceptId: reviewConcepts.id,
      stableKey: reviewConcepts.stableKey,
      layoutId: reviewConceptLayouts.id,
      layoutVersion: reviewConceptLayouts.version,
      layoutUserId: reviewConceptLayouts.userId,
      layoutSource: reviewConceptLayouts.source,
      lockedAt: reviewConceptLayouts.lockedAt,
      snapshotId: reviewConceptLayouts.snapshotId,
      pullRequestId: pullRequests.id,
    })
    .from(reviewConcepts)
    .innerJoin(
      reviewConceptLayouts,
      eq(reviewConcepts.layoutId, reviewConceptLayouts.id),
    )
    .innerJoin(
      reviewSnapshots,
      eq(reviewConceptLayouts.snapshotId, reviewSnapshots.id),
    )
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        eq(reviewConcepts.id, input.conceptId),
        eq(reviewConceptLayouts.id, input.layoutId),
        eq(workspaceMembers.userId, userId),
        eq(reviewSnapshots.headSha, pullRequests.headSha),
        eq(reviewSnapshots.baseSha, pullRequests.baseSha),
      ),
    )
    .limit(1);
  if (!candidate) throw new TRPCError({ code: "NOT_FOUND" });
  if (candidate.layoutVersion !== input.layoutVersion) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The review concept layout changed. Reload before continuing.",
    });
  }
  const activeLayouts = await tx
    .select({
      id: reviewConceptLayouts.id,
      userId: reviewConceptLayouts.userId,
    })
    .from(reviewConceptLayouts)
    .where(
      and(
        eq(reviewConceptLayouts.snapshotId, candidate.snapshotId),
        or(
          eq(reviewConceptLayouts.userId, userId),
          isNull(reviewConceptLayouts.userId),
        ),
      ),
    );
  const active =
    activeLayouts.find((layout) => layout.userId === userId) ??
    activeLayouts.find((layout) => layout.userId === null);
  let resolved = candidate;
  if (active?.id !== candidate.layoutId) {
    // The first sign-off clones a shared baseline into a personal layout, which
    // re-mints every concept id. Re-resolve the same concept by stable key so a
    // sign-off issued before the client refresh lands still succeeds.
    const [personal] =
      active && candidate.layoutUserId === null
        ? await tx
            .select({
              conceptId: reviewConcepts.id,
              stableKey: reviewConcepts.stableKey,
              layoutId: reviewConceptLayouts.id,
              layoutVersion: reviewConceptLayouts.version,
              layoutUserId: reviewConceptLayouts.userId,
              layoutSource: reviewConceptLayouts.source,
              lockedAt: reviewConceptLayouts.lockedAt,
              snapshotId: reviewConceptLayouts.snapshotId,
            })
            .from(reviewConcepts)
            .innerJoin(
              reviewConceptLayouts,
              eq(reviewConcepts.layoutId, reviewConceptLayouts.id),
            )
            .where(
              and(
                eq(reviewConceptLayouts.id, active.id),
                eq(reviewConceptLayouts.userId, userId),
                eq(reviewConcepts.stableKey, candidate.stableKey),
              ),
            )
            .limit(1)
        : [];
    if (!personal) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A newer personal review concept layout is active. Reload before continuing.",
      });
    }
    resolved = { ...personal, pullRequestId: candidate.pullRequestId };
  }
  const members = await tx
    .select({
      id: reviewUnits.id,
      complexity: reviewUnits.complexity,
      semanticHash: reviewUnits.semanticHash,
      stableKey: reviewUnits.stableKey,
      memberOrder: reviewConceptMembers.memberOrder,
    })
    .from(reviewConceptMembers)
    .innerJoin(reviewUnits, eq(reviewConceptMembers.unitId, reviewUnits.id))
    .where(eq(reviewConceptMembers.conceptId, resolved.conceptId))
    .orderBy(reviewConceptMembers.memberOrder);
  if (members.length === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This review concept no longer has any members.",
    });
  }
  return { ...resolved, members };
}

/** Permanently locks a reviewer's active layout at their first new sign-off. */
async function lockConceptLayoutForReviewer(
  tx: ReviewTransaction,
  userId: string,
  concept: Awaited<ReturnType<typeof conceptMembersForMutation>>,
) {
  const lockedAt = new Date();
  if (concept.layoutUserId === userId) {
    if (!concept.lockedAt) {
      await tx
        .update(reviewConceptLayouts)
        .set({ lockedAt })
        .where(eq(reviewConceptLayouts.id, concept.layoutId));
    }
    return;
  }

  // A shared baseline cannot carry per-reviewer lock state. Clone it once so
  // undoing a sign-off never makes grouping editable again for this reviewer.
  const baselineConcepts = await tx.query.reviewConcepts.findMany({
    where: eq(reviewConcepts.layoutId, concept.layoutId),
    orderBy: [reviewConcepts.reviewOrder],
  });
  const baselineConceptIds = baselineConcepts.map(({ id }) => id);
  const [baselineMembers, baselineDependencies] = baselineConceptIds.length
    ? await Promise.all([
        tx
          .select()
          .from(reviewConceptMembers)
          .where(inArray(reviewConceptMembers.conceptId, baselineConceptIds)),
        tx
          .select()
          .from(reviewConceptDependencies)
          .where(
            inArray(reviewConceptDependencies.conceptId, baselineConceptIds),
          ),
      ])
    : [[], []];
  const [personal] = await tx
    .insert(reviewConceptLayouts)
    .values({
      snapshotId: concept.snapshotId,
      userId,
      source: concept.layoutSource,
      version: concept.layoutVersion,
      lockedAt,
    })
    .returning({ id: reviewConceptLayouts.id });
  if (!personal)
    throw new Error("The review concept layout could not be locked");
  const copiedConcepts = await tx
    .insert(reviewConcepts)
    .values(
      baselineConcepts.map((item) => ({
        layoutId: personal.id,
        stableKey: item.stableKey,
        title: item.title,
        rationale: item.rationale,
        reviewOrder: item.reviewOrder,
        changedLineCount: item.changedLineCount,
        fileCount: item.fileCount,
        oversized: item.oversized,
      })),
    )
    .returning({ id: reviewConcepts.id, stableKey: reviewConcepts.stableKey });
  const copiedIdByStableKey = new Map(
    copiedConcepts.map((item) => [item.stableKey, item.id]),
  );
  const baselineById = new Map(baselineConcepts.map((item) => [item.id, item]));
  const copiedIdByBaselineId = new Map(
    baselineConcepts.flatMap((item) => {
      const copiedId = copiedIdByStableKey.get(item.stableKey);
      return copiedId ? [[item.id, copiedId] as const] : [];
    }),
  );
  if (baselineMembers.length > 0) {
    await tx.insert(reviewConceptMembers).values(
      baselineMembers.flatMap((member) => {
        const conceptId = copiedIdByBaselineId.get(member.conceptId);
        return conceptId
          ? [
              {
                layoutId: personal.id,
                conceptId,
                unitId: member.unitId,
                snapshotId: concept.snapshotId,
                memberOrder: member.memberOrder,
              },
            ]
          : [];
      }),
    );
  }
  if (baselineDependencies.length > 0) {
    await tx.insert(reviewConceptDependencies).values(
      baselineDependencies.flatMap((dependency) => {
        const conceptId = copiedIdByBaselineId.get(dependency.conceptId);
        const dependencyId = copiedIdByBaselineId.get(dependency.dependencyId);
        return conceptId && dependencyId
          ? [{ layoutId: personal.id, conceptId, dependencyId }]
          : [];
      }),
    );
  }
  // Retain this check as an internal invariant and keep the copied map useful
  // when a malformed baseline is encountered inside the transaction.
  if (baselineById.size !== copiedIdByBaselineId.size) {
    throw new Error("The review concept layout could not be copied completely");
  }
}

/**
 * Persists authorized sign-offs in set-at-a-time steps so a batch or concept
 * holds its advisory locks for a fixed number of round trips.
 */
async function persistSignOffs(
  tx: ReviewTransaction,
  userId: string,
  inputs: SignOffInput[],
): Promise<Map<string, SignOffOutcome>> {
  const outcomes = new Map<string, SignOffOutcome>();
  if (inputs.length === 0) return outcomes;
  const requestedUnits = await tx
    .select({
      id: reviewUnits.id,
      stableKey: reviewUnits.stableKey,
      semanticHash: reviewUnits.semanticHash,
      pullRequestId: pullRequests.id,
      currentHeadSha: pullRequests.headSha,
      currentBaseSha: pullRequests.baseSha,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        inArray(reviewUnits.id, [
          ...new Set(inputs.map(({ unitId }) => unitId)),
        ]),
        eq(workspaceMembers.userId, userId),
      ),
    );
  const requestedById = new Map(requestedUnits.map((unit) => [unit.id, unit]));

  const revisionScopes = new Map<
    string,
    { headSha: string; baseSha: string; stableKeys: Set<string> }
  >();
  for (const unit of requestedUnits) {
    const scope = revisionScopes.get(unit.pullRequestId) ?? {
      headSha: unit.currentHeadSha,
      baseSha: unit.currentBaseSha,
      stableKeys: new Set<string>(),
    };
    scope.stableKeys.add(unit.stableKey);
    revisionScopes.set(unit.pullRequestId, scope);
  }
  // Serialize this reviewer's sign-off writes per pull request. Sorting the
  // keys gives every caller the same acquisition order, so two batches that
  // overlap on two pull requests cannot deadlock against each other.
  for (const pullRequestId of [...revisionScopes.keys()].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${pullRequestId}:${userId}`}))`,
    );
  }

  const revisionFilters = [...revisionScopes].map(([pullRequestId, scope]) =>
    and(
      eq(reviewSnapshots.pullRequestId, pullRequestId),
      eq(reviewSnapshots.headSha, scope.headSha),
      eq(reviewSnapshots.baseSha, scope.baseSha),
      inArray(reviewUnits.stableKey, [...scope.stableKeys]),
    ),
  );
  // Only the highest snapshot version still describing the pull request's
  // current revision may receive a sign-off.
  const latestRevisions = revisionFilters.length
    ? await tx
        .selectDistinctOn(
          [reviewSnapshots.pullRequestId, reviewUnits.stableKey],
          {
            id: reviewUnits.id,
            stableKey: reviewUnits.stableKey,
            semanticHash: reviewUnits.semanticHash,
            complexity: reviewUnits.complexity,
            snapshotId: reviewUnits.snapshotId,
            pullRequestId: reviewSnapshots.pullRequestId,
          },
        )
        .from(reviewUnits)
        .innerJoin(
          reviewSnapshots,
          eq(reviewUnits.snapshotId, reviewSnapshots.id),
        )
        .where(or(...revisionFilters))
        .orderBy(
          reviewSnapshots.pullRequestId,
          reviewUnits.stableKey,
          desc(reviewSnapshots.version),
        )
    : [];
  const latestByStableKey = new Map(
    latestRevisions.map((unit) => [
      revisionKey(unit.pullRequestId, unit.stableKey),
      unit,
    ]),
  );

  interface ResolvedSignOff {
    input: SignOffInput;
    pullRequestId: string;
    unit: (typeof latestRevisions)[number];
  }
  const resolved: ResolvedSignOff[] = [];
  for (const input of inputs) {
    const requested = requestedById.get(input.unitId);
    if (!requested) {
      outcomes.set(input.unitId, { code: "NOT_FOUND", ok: false });
      continue;
    }
    const unit = latestByStableKey.get(
      revisionKey(requested.pullRequestId, requested.stableKey),
    );
    if (!unit || unit.semanticHash !== requested.semanticHash) {
      outcomes.set(input.unitId, {
        code: "CONFLICT",
        message: "This review unit changed in the latest revision",
        ok: false,
      });
      continue;
    }
    resolved.push({ input, pullRequestId: requested.pullRequestId, unit });
  }
  if (resolved.length === 0) return outcomes;

  const targetUnitIds = [...new Set(resolved.map(({ unit }) => unit.id))];
  // Every writer of these rows takes the pull-request lock above first, so no
  // other transaction can hold one of these unit locks in a conflicting order.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(key)) from unnest(array[${sql.join(
      targetUnitIds.map((unitId) => sql`${`${unitId}:${userId}`}`),
      sql`, `,
    )}]::text[]) as locks(key)`,
  );
  const activeSignOffs = await tx
    .select()
    .from(signOffs)
    .where(
      and(
        eq(signOffs.userId, userId),
        inArray(signOffs.unitId, targetUnitIds),
        isNull(signOffs.invalidatedAt),
      ),
    );
  const activeByRevision = new Map<string, (typeof activeSignOffs)[number]>();
  for (const signOff of activeSignOffs) {
    const key = revisionKey(signOff.unitId, signOff.semanticHash);
    if (!activeByRevision.has(key)) activeByRevision.set(key, signOff);
  }

  // One insert per unit, credited to the first request that reached it, so a
  // set naming two revisions of one unit behaves as it did one at a time.
  const claimants = new Map<string, SignOffInput>();
  const pendingInserts: ResolvedSignOff[] = [];
  for (const entry of resolved) {
    const key = revisionKey(entry.unit.id, entry.unit.semanticHash);
    if (activeByRevision.has(key) || claimants.has(entry.unit.id)) continue;
    claimants.set(entry.unit.id, entry.input);
    pendingInserts.push(entry);
  }
  const insertedByUnit = new Map<string, (typeof activeSignOffs)[number]>();
  if (pendingInserts.length > 0) {
    await tx
      .update(signOffs)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          inArray(
            signOffs.unitId,
            pendingInserts.map(({ unit }) => unit.id),
          ),
          eq(signOffs.userId, userId),
          isNull(signOffs.invalidatedAt),
        ),
      );
    const written = await tx
      .insert(signOffs)
      .values(
        pendingInserts.map(({ input, unit }) => ({
          unitId: unit.id,
          userId,
          semanticHash: unit.semanticHash,
          note: input.note,
          durationSeconds: input.durationSeconds,
        })),
      )
      .returning();
    for (const signOff of written) insertedByUnit.set(signOff.unitId, signOff);
  }

  for (const entry of resolved) {
    const existing = activeByRevision.get(
      revisionKey(entry.unit.id, entry.unit.semanticHash),
    );
    const signOff = existing ?? insertedByUnit.get(entry.unit.id);
    if (!signOff) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The sign-off could not be saved",
      });
    }
    outcomes.set(entry.input.unitId, {
      ok: true,
      write: {
        added: !existing && claimants.get(entry.unit.id) === entry.input,
        experience: reviewExperience(
          entry.unit.complexity,
          entry.input.durationSeconds,
        ),
        input: entry.input,
        pullRequestId: entry.pullRequestId,
        signOff,
        snapshotId: entry.unit.snapshotId,
      },
    });
  }
  return outcomes;
}

/** Reports one rejected sign-off exactly as the single-unit mutation always has. */
function signOffFailure(outcome: SignOffOutcome & { ok: false }) {
  return new TRPCError({ code: outcome.code, message: outcome.message });
}

/** Applies aggregate user and review-session updates once per sign-off request. */
async function finalizeSignOffs(
  tx: ReviewTransaction,
  userId: string,
  writes: PersistedSignOff[],
) {
  const added = writes.filter((write) => write.added);
  if (added.length === 0) return;
  await recomputeReviewStats(tx, userId);

  const sessionGroups = new Map<string, PersistedSignOff[]>();
  for (const write of added) {
    if (!write.input.sessionId) continue;
    const key = `${write.input.sessionId}:${write.snapshotId}:${write.pullRequestId}`;
    const existing = sessionGroups.get(key);
    if (existing) existing.push(write);
    else sessionGroups.set(key, [write]);
  }
  for (const writesForSession of sessionGroups.values()) {
    const first = writesForSession[0];
    if (!first?.input.sessionId) continue;
    const [updatedSession] = await tx
      .update(reviewSessions)
      .set({
        reviewedUnits: sql`${reviewSessions.reviewedUnits} + ${writesForSession.length}`,
        experienceAwarded: sql`${reviewSessions.experienceAwarded} + ${writesForSession.reduce((total, write) => total + write.experience, 0)}`,
      })
      .where(
        and(
          eq(reviewSessions.id, first.input.sessionId),
          eq(reviewSessions.userId, userId),
          eq(reviewSessions.snapshotId, first.snapshotId),
          eq(reviewSessions.pullRequestId, first.pullRequestId),
        ),
      )
      .returning({ id: reviewSessions.id });
    if (!updatedSession) continue;
    const completion = await reviewCompletionCounts(
      tx,
      first.snapshotId,
      userId,
    );
    if (completion.total > 0 && completion.signed >= completion.total) {
      await tx
        .update(reviewSessions)
        .set({ completedAt: new Date() })
        .where(eq(reviewSessions.id, updatedSession.id));
    }
  }
}

/**
 * Records one reviewer's wait on every named unit of a single snapshot.
 *
 * Each wait watches that unit's own conversation. A unit with no thread of
 * its own cannot be paused, because there is nothing for a later poll to
 * notice having moved.
 */
async function beginReviewWaits(
  db: typeof database,
  userId: string,
  requested: string[],
) {
  const unitIds = [...new Set(requested)];
  const scopes = await db
    .select({
      unitId: reviewUnits.id,
      path: reviewUnits.path,
      startLine: reviewUnits.startLine,
      endLine: reviewUnits.endLine,
      snapshotId: reviewUnits.snapshotId,
      snapshotHeadSha: reviewSnapshots.headSha,
      snapshotBaseSha: reviewSnapshots.baseSha,
      pullRequestNumber: pullRequests.number,
      headSha: pullRequests.headSha,
      baseSha: pullRequests.baseSha,
      repositoryExternalId: repositories.externalId,
      connection: providerConnections,
    })
    .from(reviewUnits)
    .innerJoin(reviewSnapshots, eq(reviewUnits.snapshotId, reviewSnapshots.id))
    .innerJoin(pullRequests, eq(reviewSnapshots.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .leftJoin(
      providerConnections,
      eq(repositories.connectionId, providerConnections.id),
    )
    .innerJoin(
      workspaceMembers,
      eq(repositories.workspaceId, workspaceMembers.workspaceId),
    )
    .where(
      and(
        inArray(reviewUnits.id, unitIds),
        eq(workspaceMembers.userId, userId),
      ),
    );
  const units = [
    ...new Map(scopes.map((scope) => [scope.unitId, scope])).values(),
  ];
  const [scope] = units;
  if (!scope || units.length !== unitIds.length) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  if (
    scope.snapshotHeadSha !== scope.headSha ||
    scope.snapshotBaseSha !== scope.baseSha
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Synchronize the pull request before waiting for a response",
    });
  }
  if (!scope.connection) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Local comments do not have provider response threads",
    });
  }
  const provider = await providerForConnection(db, scope.connection);
  let threads: Awaited<ReturnType<typeof provider.listInlineCommentThreads>>;
  try {
    threads = await provider.listInlineCommentThreads(
      scope.repositoryExternalId,
      scope.pullRequestNumber,
    );
  } catch (cause) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: providerSyncErrorMessage(scope.connection.provider, cause),
      cause,
    });
  }
  const allSnapshotUnits = await db
    .select({
      id: reviewUnits.id,
      path: reviewUnits.path,
      kind: reviewUnits.kind,
      startLine: reviewUnits.startLine,
      endLine: reviewUnits.endLine,
    })
    .from(reviewUnits)
    .where(eq(reviewUnits.snapshotId, scope.snapshotId));
  const snapshotUnits = allSnapshotUnits.filter(({ kind }) => kind !== "file");
  const localComments = await db
    .select({
      unitId: reviewComments.unitId,
      providerExternalId: reviewComments.providerExternalId,
    })
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.status, "published"),
        inArray(
          reviewComments.unitId,
          snapshotUnits.map(({ id }) => id),
        ),
      ),
    );
  const explicitlyAssignedUnitByThreadId = new Map(
    localComments.flatMap((comment) =>
      comment.providerExternalId
        ? [[comment.providerExternalId, comment.unitId] as const]
        : [],
    ),
  );
  const assignedThreads = assignProviderThreadsToUnits(
    threads,
    snapshotUnits,
    explicitlyAssignedUnitByThreadId,
  );
  const waited = units.map((unit) => ({
    unit,
    activity: providerActivityForUnit(
      assignedThreads.filter((thread) => thread.unitId === unit.unitId),
      unit,
    ),
  }));
  if (waited.every(({ activity }) => activity.providerThreadIds.length === 0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This unit needs a live provider conversation before it can await a response",
    });
  }

  return db.transaction(async (tx) => {
    // Sorted, because two reviewers pausing overlapping sets would otherwise
    // take the same per-unit locks in opposite orders and deadlock.
    for (const unitId of [...unitIds].sort()) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${unitId}:${userId}:wait`}))`,
      );
    }
    await tx
      .update(signOffs)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          inArray(
            signOffs.unitId,
            units.map(({ unitId }) => unitId),
          ),
          eq(signOffs.userId, userId),
          isNull(signOffs.invalidatedAt),
        ),
      );
    const waitingSince = new Date();
    const written: (typeof reviewWaits.$inferSelect)[] = [];
    for (const { unit, activity } of waited) {
      const [wait] = await tx
        .insert(reviewWaits)
        .values({
          unitId: unit.unitId,
          userId,
          providerThreadIds: activity.providerThreadIds,
          observedCommentIds: activity.observedCommentIds,
          waitingSince,
        })
        .onConflictDoUpdate({
          target: [reviewWaits.unitId, reviewWaits.userId],
          set: {
            providerThreadIds: activity.providerThreadIds,
            observedCommentIds: activity.observedCommentIds,
            waitingSince,
          },
        })
        .returning();
      if (!wait) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The waiting state could not be saved",
        });
      }
      written.push(wait);
    }
    return written;
  });
}

export const reviewRouter = createTRPCRouter({
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        authorLogin: pullRequests.authorLogin,
        authorAvatarUrl: pullRequests.authorAvatarUrl,
        state: pullRequests.state,
        webUrl: pullRequests.webUrl,
        updatedAt: pullRequests.updatedAt,
        additions: pullRequests.additions,
        deletions: pullRequests.deletions,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        provider: providerConnections.provider,
        queueState: reviewQueueItems.state,
        queueSource: reviewQueueItems.source,
        removedAt: reviewQueueItems.removedAt,
      })
      .from(pullRequests)
      .innerJoin(
        reviewQueueItems,
        and(
          eq(reviewQueueItems.pullRequestId, pullRequests.id),
          eq(reviewQueueItems.userId, ctx.auth.userId),
        ),
      )
      .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .innerJoin(
        workspaceMembers,
        eq(repositories.workspaceId, workspaceMembers.workspaceId),
      )
      .where(eq(workspaceMembers.userId, ctx.auth.userId))
      .orderBy(desc(pullRequests.updatedAt));
    if (rows.length === 0) return [];
    const snapshots = await ctx.db
      .selectDistinctOn([reviewSnapshots.pullRequestId], {
        id: reviewSnapshots.id,
        pullRequestId: reviewSnapshots.pullRequestId,
      })
      .from(reviewSnapshots)
      .where(
        inArray(
          reviewSnapshots.pullRequestId,
          rows.map(({ id }) => id),
        ),
      )
      .orderBy(reviewSnapshots.pullRequestId, desc(reviewSnapshots.version));
    if (snapshots.length === 0) {
      return rows.map((row) => ({
        ...row,
        totalUnits: 0,
        signedUnits: 0,
        carriedSignOffs: 0,
      }));
    }
    const units = await ctx.db
      .select({
        id: reviewUnits.id,
        snapshotId: reviewUnits.snapshotId,
        createdAt: reviewUnits.createdAt,
        kind: reviewUnits.kind,
      })
      .from(reviewUnits)
      .where(
        inArray(
          reviewUnits.snapshotId,
          snapshots.map(({ id }) => id),
        ),
      );
    const reviewableUnits = units.filter(({ kind }) => kind !== "file");
    const unitIds = reviewableUnits.map(({ id }) => id);
    const currentSignOffs =
      unitIds.length > 0
        ? await ctx.db
            .select({
              unitId: signOffs.unitId,
              signedOffAt: signOffs.signedOffAt,
            })
            .from(signOffs)
            .where(
              and(
                eq(signOffs.userId, ctx.auth.userId),
                inArray(signOffs.unitId, unitIds),
                isNull(signOffs.invalidatedAt),
              ),
            )
        : [];
    const signOffByUnit = new Map(
      currentSignOffs.map((signOff) => [signOff.unitId, signOff]),
    );
    const unitsBySnapshot = new Map<string, typeof units>();
    for (const unit of reviewableUnits) {
      const existing = unitsBySnapshot.get(unit.snapshotId);
      if (existing) existing.push(unit);
      else unitsBySnapshot.set(unit.snapshotId, [unit]);
    }
    const snapshotByPullRequest = new Map(
      snapshots.map((snapshot) => [snapshot.pullRequestId, snapshot.id]),
    );
    return rows.map((row) => {
      const snapshotUnits =
        unitsBySnapshot.get(snapshotByPullRequest.get(row.id) ?? "") ?? [];
      const signedUnits = snapshotUnits.filter((unit) =>
        signOffByUnit.has(unit.id),
      );
      return {
        ...row,
        totalUnits: snapshotUnits.length,
        signedUnits: signedUnits.length,
        carriedSignOffs: signedUnits.filter((unit) => {
          const signOff = signOffByUnit.get(unit.id);
          return signOff && signOff.signedOffAt < unit.createdAt;
        }).length,
      };
    });
  }),

  removeFromQueue: protectedProcedure
    .input(z.object({ pullRequestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [accessible] = await ctx.db
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(pullRequests.id, input.pullRequestId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });
      const removed = await removePullRequestFromQueue(ctx.db, {
        pullRequestId: input.pullRequestId,
        userId: ctx.auth.userId,
      });
      if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
      return removed;
    }),

  restoreToQueue: protectedProcedure
    .input(z.object({ pullRequestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [accessible] = await ctx.db
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(pullRequests.id, input.pullRequestId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });
      const restored = await restorePullRequestToQueue(ctx.db, {
        pullRequestId: input.pullRequestId,
        userId: ctx.auth.userId,
      });
      if (!restored) throw new TRPCError({ code: "NOT_FOUND" });
      return restored;
    }),

  workspace: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      const [pullRequest] = await ctx.db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          description: pullRequests.description,
          authorLogin: pullRequests.authorLogin,
          sourceBranch: pullRequests.sourceBranch,
          targetBranch: pullRequests.targetBranch,
          headSha: pullRequests.headSha,
          baseSha: pullRequests.baseSha,
          webUrl: pullRequests.webUrl,
          repositoryId: repositories.id,
          repositoryOwner: repositories.owner,
          repositoryName: repositories.name,
          repositoryWebUrl: repositories.webUrl,
          provider: providerConnections.provider,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!pullRequest) throw new TRPCError({ code: "NOT_FOUND" });
      const [snapshot, previousSnapshot] =
        await ctx.db.query.reviewSnapshots.findMany({
          where: eq(reviewSnapshots.pullRequestId, pullRequest.id),
          orderBy: [desc(reviewSnapshots.version)],
          limit: 2,
        });
      if (!snapshot)
        return {
          pullRequest,
          snapshot: null,
          previousSnapshot: null,
          units: [],
          files: [],
          fileContexts: [],
          conceptLayout: null,
          concepts: [],
          sourceDelivery: isLocalDeployment()
            ? ("inline" as const)
            : ("direct" as const),
        };
      // The unit list, the reviewer's concept layouts and their sign-offs on
      // earlier revisions depend only on the snapshot, so they are one round.
      const [storedUnits, storedFiles, layouts, priorSignedUnits, priorUnits] =
        await Promise.all([
          ctx.db.query.reviewUnits.findMany({
            where: eq(reviewUnits.snapshotId, snapshot.id),
            orderBy: [reviewUnits.reviewOrder],
          }),
          ctx.db.query.snapshotFiles.findMany({
            where: eq(snapshotFiles.snapshotId, snapshot.id),
            orderBy: [snapshotFiles.path],
            columns: {
              id: true,
              path: true,
              previousPath: true,
              changeType: true,
              additions: true,
              deletions: true,
              isBinary: true,
              skipReason: true,
            },
          }),
          ctx.db
            .select()
            .from(reviewConceptLayouts)
            .where(
              and(
                eq(reviewConceptLayouts.snapshotId, snapshot.id),
                or(
                  eq(reviewConceptLayouts.userId, ctx.auth.userId),
                  isNull(reviewConceptLayouts.userId),
                ),
              ),
            ),
          snapshot.version > 1
            ? ctx.db
                .selectDistinct({ stableKey: reviewUnits.stableKey })
                .from(signOffs)
                .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
                .innerJoin(
                  reviewSnapshots,
                  eq(reviewUnits.snapshotId, reviewSnapshots.id),
                )
                .where(
                  and(
                    eq(signOffs.userId, ctx.auth.userId),
                    isNull(signOffs.invalidatedAt),
                    eq(reviewSnapshots.pullRequestId, pullRequest.id),
                    lt(reviewSnapshots.version, snapshot.version),
                  ),
                )
            : [],
          previousSnapshot
            ? ctx.db.query.reviewUnits.findMany({
                where: eq(reviewUnits.snapshotId, previousSnapshot.id),
                columns: { stableKey: true },
              })
            : [],
        ]);
      const activeLayout =
        layouts.find(({ userId }) => userId === ctx.auth.userId) ??
        layouts.find(({ userId }) => userId === null);
      // Source hydration, per-unit review state and the concepts of the active
      // layout are all derived from that round and are independent of one
      // another, so they issue together instead of one after the next.
      const reviewableUnitIds = storedUnits
        .filter(({ kind }) => kind !== "file")
        .map(({ id }) => id);
      const [
        allUnits,
        dependencyRows,
        userSignOffs,
        userWaits,
        storedConcepts,
      ] = await Promise.all([
        isLocalDeployment()
          ? hydrateReviewUnits(ctx.db, storedUnits)
          : storedUnits.map((unit) => ({
              ...unit,
              source: "",
              previousSource: null,
            })),
        reviewableUnitIds.length
          ? ctx.db
              .select({
                unitId: reviewUnitDependencies.unitId,
                dependencyId: reviewUnitDependencies.dependencyId,
              })
              .from(reviewUnitDependencies)
              .where(inArray(reviewUnitDependencies.unitId, reviewableUnitIds))
          : [],
        reviewableUnitIds.length
          ? ctx.db
              .select({
                unitId: signOffs.unitId,
                signedOffAt: signOffs.signedOffAt,
              })
              .from(signOffs)
              .where(
                and(
                  eq(signOffs.userId, ctx.auth.userId),
                  inArray(signOffs.unitId, reviewableUnitIds),
                  isNull(signOffs.invalidatedAt),
                ),
              )
          : [],
        reviewableUnitIds.length
          ? ctx.db
              .select({
                unitId: reviewWaits.unitId,
                waitingSince: reviewWaits.waitingSince,
              })
              .from(reviewWaits)
              .where(
                and(
                  eq(reviewWaits.userId, ctx.auth.userId),
                  inArray(reviewWaits.unitId, reviewableUnitIds),
                ),
              )
          : [],
        activeLayout
          ? ctx.db.query.reviewConcepts.findMany({
              where: eq(reviewConcepts.layoutId, activeLayout.id),
              orderBy: [reviewConcepts.reviewOrder],
            })
          : [],
      ]);
      const units = allUnits.filter(({ kind }) => kind !== "file");
      const fileContexts = allUnits.filter(({ kind }) => kind === "file");
      const dependenciesByUnit = new Map<string, string[]>();
      for (const { unitId, dependencyId } of dependencyRows) {
        const existing = dependenciesByUnit.get(unitId);
        if (existing) existing.push(dependencyId);
        else dependenciesByUnit.set(unitId, [dependencyId]);
      }
      const signedUnitIds = new Set(
        userSignOffs.map((signOff) => signOff.unitId),
      );
      const signedOffAtByUnitId = new Map(
        userSignOffs.map((signOff) => [signOff.unitId, signOff.signedOffAt]),
      );
      const layoutLockedByNewSignOff = userSignOffs.some(
        ({ signedOffAt }) => signedOffAt >= snapshot.createdAt,
      );
      const waitByUnitId = new Map(
        userWaits.map((wait) => [wait.unitId, wait]),
      );
      const previouslySignedStableKeys = new Set(
        priorSignedUnits.map(({ stableKey }) => stableKey),
      );
      const previousStableKeys = new Set(
        priorUnits.map(({ stableKey }) => stableKey),
      );
      const workspaceUnits = units.map((unit) => {
        const wait = waitByUnitId.get(unit.id);
        const signedOffAt = signedOffAtByUnitId.get(unit.id);
        return {
          ...unit,
          dependencies: dependenciesByUnit.get(unit.id) ?? [],
          status: wait
            ? ("waiting" as const)
            : signedUnitIds.has(unit.id)
              ? ("signed_off" as const)
              : unit.requiresReReview &&
                  previouslySignedStableKeys.has(unit.stableKey)
                ? ("changed" as const)
                : ("pending" as const),
          waitingSince: wait?.waitingSince ?? null,
          changedSinceSignOff:
            unit.requiresReReview &&
            previouslySignedStableKeys.has(unit.stableKey),
          revisionState:
            snapshot.version === 1
              ? ("initial" as const)
              : !previousStableKeys.has(unit.stableKey)
                ? ("new" as const)
                : unit.requiresReReview
                  ? ("updated" as const)
                  : ("unchanged" as const),
          signOffOrigin: signedOffAt
            ? signedOffAt < snapshot.createdAt
              ? ("preserved" as const)
              : ("current" as const)
            : ("none" as const),
        };
      });
      let conceptLayout: {
        id: string;
        version: number;
        source: "deterministic" | "manual" | "ai";
        locked: boolean;
        personal: boolean;
      } | null = null;
      let concepts: Array<{
        id: string;
        stableKey: string;
        title: string;
        rationale: string | null;
        reviewOrder: number;
        changedLineCount: number;
        fileCount: number;
        oversized: boolean;
        dependencies: string[];
        memberIds: string[];
        status: "pending" | "partial" | "waiting" | "signed_off" | "changed";
        signedMemberCount: number;
      }> = [];
      if (activeLayout) {
        conceptLayout = {
          id: activeLayout.id,
          version: activeLayout.version,
          source: activeLayout.source,
          locked: Boolean(activeLayout.lockedAt) || layoutLockedByNewSignOff,
          personal: Boolean(activeLayout.userId),
        };
        const conceptIds = storedConcepts.map(({ id }) => id);
        const [memberRows, conceptDependencyRows] = conceptIds.length
          ? await Promise.all([
              ctx.db
                .select()
                .from(reviewConceptMembers)
                .where(inArray(reviewConceptMembers.conceptId, conceptIds)),
              ctx.db
                .select()
                .from(reviewConceptDependencies)
                .where(
                  inArray(reviewConceptDependencies.conceptId, conceptIds),
                ),
            ])
          : [[], []];
        const membersByConcept = new Map<string, typeof memberRows>();
        for (const member of memberRows) {
          const existing = membersByConcept.get(member.conceptId);
          if (existing) existing.push(member);
          else membersByConcept.set(member.conceptId, [member]);
        }
        const dependenciesByConcept = new Map<string, string[]>();
        for (const dependency of conceptDependencyRows) {
          const existing = dependenciesByConcept.get(dependency.conceptId);
          if (existing) existing.push(dependency.dependencyId);
          else {
            dependenciesByConcept.set(dependency.conceptId, [
              dependency.dependencyId,
            ]);
          }
        }
        const unitById = new Map(workspaceUnits.map((unit) => [unit.id, unit]));
        concepts = storedConcepts.map((concept) => {
          const memberIds = (membersByConcept.get(concept.id) ?? [])
            .sort((left, right) => left.memberOrder - right.memberOrder)
            .map(({ unitId }) => unitId);
          const members = memberIds
            .map((id) => unitById.get(id))
            .filter((unit): unit is (typeof workspaceUnits)[number] =>
              Boolean(unit),
            );
          const signedMemberCount = members.filter(
            ({ status }) => status === "signed_off",
          ).length;
          return {
            ...concept,
            dependencies: dependenciesByConcept.get(concept.id) ?? [],
            memberIds,
            status: conceptStatusFromMembers(members, memberIds.length),
            signedMemberCount,
          };
        });
      } else {
        // Snapshots produced before concept analysis remain fully reviewable and
        // fail safe as one-unit concepts until their next synchronization.
        concepts = workspaceUnits.map((unit, reviewOrder) => ({
          id: unit.id,
          stableKey: `singleton:${unit.stableKey}`,
          title: unit.name,
          rationale: "This snapshot predates concept grouping.",
          reviewOrder,
          changedLineCount: unit.changedLineCount,
          fileCount: 1,
          oversized: unit.changedLineCount > MAX_CONCEPT_CHANGED_LINES,
          dependencies: [],
          memberIds: [unit.id],
          status: unit.status,
          signedMemberCount: unit.status === "signed_off" ? 1 : 0,
        }));
      }
      return {
        pullRequest,
        snapshot,
        sourceDelivery: isLocalDeployment()
          ? ("inline" as const)
          : ("direct" as const),
        previousSnapshot: previousSnapshot
          ? {
              id: previousSnapshot.id,
              headSha: previousSnapshot.headSha,
              version: previousSnapshot.version,
            }
          : null,
        files: storedFiles,
        fileContexts,
        conceptLayout,
        concepts,
        units: workspaceUnits,
      };
    }),

  providerReviewState: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      // The reviewer-wide gate reads nothing the lookup produces, so the two
      // share one round trip.
      const [scope] = await Promise.all([
        providerScopeForPullRequest(
          ctx.db,
          ctx.auth.userId,
          input.pullRequestId,
        ),
        enforceRateLimit(
          ctx.db,
          `provider-review-state:${ctx.auth.userId}`,
          60,
          60_000,
        ),
      ]);
      await enforceRateLimit(
        ctx.db,
        `provider-review-state-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );
      try {
        const provider = await providerForConnection(ctx.db, scope.connection);
        const [state, remotePullRequest] = await Promise.all([
          provider.getPullRequestReviewState(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        const revisionCurrent =
          remotePullRequest.headSha === scope.headSha &&
          remotePullRequest.baseSha === scope.baseSha &&
          scope.snapshot?.headSha === scope.headSha &&
          scope.snapshot?.baseSha === scope.baseSha;
        return {
          ...state,
          provider: scope.connection.provider,
          revisionCurrent,
          syncedAt: new Date(),
          canApprove: revisionCurrent && state.canApprove,
          canRequestChanges: revisionCurrent && state.canRequestChanges,
          canClear: revisionCurrent && state.canClear,
          unavailableReason: revisionCurrent
            ? state.unavailableReason
            : "The provider has a newer revision. Synchronize this pull request before changing its review decision.",
        };
      } catch (cause) {
        throw providerOperationError(
          scope.connection.provider,
          cause,
          "review",
        );
      }
    }),

  providerLifecycle: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      // The reviewer-wide gate reads nothing the lookup produces, so the two
      // share one round trip.
      const [scope] = await Promise.all([
        providerScopeForPullRequest(
          ctx.db,
          ctx.auth.userId,
          input.pullRequestId,
        ),
        enforceRateLimit(
          ctx.db,
          `provider-lifecycle:${ctx.auth.userId}`,
          60,
          60_000,
        ),
      ]);
      await enforceRateLimit(
        ctx.db,
        `provider-lifecycle-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );
      try {
        const provider = await providerForConnection(ctx.db, scope.connection);
        const [lifecycle, remotePullRequest] = await Promise.all([
          provider.getPullRequestLifecycle(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        return scopedProviderLifecycle(scope, lifecycle, remotePullRequest);
      } catch (cause) {
        throw providerOperationError(
          scope.connection.provider,
          cause,
          "lifecycle",
        );
      }
    }),

  mergePullRequest: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `provider-merge:${ctx.auth.userId}`,
        10,
        10 * 60_000,
      );
      const scope = await providerScopeForPullRequest(
        ctx.db,
        ctx.auth.userId,
        input.pullRequestId,
      );
      if (
        !scope.snapshot ||
        scope.snapshot.headSha !== scope.headSha ||
        scope.snapshot.baseSha !== scope.baseSha
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Synchronize the pull request before merging",
        });
      }
      const completion = await reviewCompletionCounts(
        ctx.db,
        scope.snapshot.id,
        ctx.auth.userId,
      );
      if (completion.total === 0 || completion.signed < completion.total) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Complete every review unit before merging",
        });
      }
      if (
        scope.pullRequestState !== "open" &&
        scope.pullRequestState !== "draft"
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This pull request is no longer open",
        });
      }
      try {
        const provider = await providerForConnection(ctx.db, scope.connection);
        const [remotePullRequest, currentLifecycle] = await Promise.all([
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequestLifecycle(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        if (
          remotePullRequest.headSha !== scope.headSha ||
          remotePullRequest.baseSha !== scope.baseSha
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The provider has a newer revision. Synchronize it before merging.",
          });
        }
        if (currentLifecycle.pullRequestState === "merged") {
          await ctx.db
            .update(pullRequests)
            .set({ state: "merged", lastSyncedAt: new Date() })
            .where(eq(pullRequests.id, scope.pullRequestId));
          return scopedProviderLifecycle(
            scope,
            currentLifecycle,
            remotePullRequest,
          );
        }
        if (!currentLifecycle.canMerge) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              currentLifecycle.mergeBlockedReason ??
              "The provider is not ready to merge this pull request",
          });
        }
        await provider.mergePullRequest({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          headSha: scope.headSha,
        });
        let updatedLifecycle: ProviderPullRequestLifecycle;
        try {
          updatedLifecycle = await provider.getPullRequestLifecycle(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          );
        } catch {
          updatedLifecycle = buildProviderLifecycle({
            checks: currentLifecycle.checks,
            pullRequestState: "merged",
            headSha: scope.headSha,
            mergeable: true,
            canMerge: false,
            mergeBlockedReason:
              scope.connection.provider === "azure_devops"
                ? "Already completed"
                : "Already merged",
            mergeActionLabel: currentLifecycle.mergeActionLabel,
          });
        }
        if (
          updatedLifecycle.pullRequestState === "merged" ||
          updatedLifecycle.pullRequestState === "closed"
        ) {
          await ctx.db
            .update(pullRequests)
            .set({
              state: updatedLifecycle.pullRequestState,
              lastSyncedAt: new Date(),
            })
            .where(eq(pullRequests.id, scope.pullRequestId));
        }
        return scopedProviderLifecycle(
          scope,
          updatedLifecycle,
          remotePullRequest,
        );
      } catch (cause) {
        throw providerOperationError(scope.connection.provider, cause, "merge");
      }
    }),

  setProviderReviewDecision: protectedProcedure
    .input(providerReviewDecisionSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `provider-review-decision:${ctx.auth.userId}`,
        20,
        10 * 60_000,
      );
      const scope = await providerScopeForPullRequest(
        ctx.db,
        ctx.auth.userId,
        input.pullRequestId,
      );
      if (
        !scope.snapshot ||
        scope.snapshot.headSha !== scope.headSha ||
        scope.snapshot.baseSha !== scope.baseSha
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Synchronize the pull request before changing its review decision",
        });
      }
      const completion = await reviewCompletionCounts(
        ctx.db,
        scope.snapshot.id,
        ctx.auth.userId,
      );
      if (completion.total === 0 || completion.signed < completion.total) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Complete every review unit before changing the provider review decision",
        });
      }
      if (
        scope.pullRequestState !== "open" &&
        scope.pullRequestState !== "draft"
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This pull request is no longer open for review",
        });
      }
      try {
        const provider = await providerForConnection(ctx.db, scope.connection);
        const [remotePullRequest, currentState] = await Promise.all([
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequestReviewState(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        if (
          remotePullRequest.headSha !== scope.headSha ||
          remotePullRequest.baseSha !== scope.baseSha
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The provider has a newer revision. Synchronize it before changing the review decision.",
          });
        }
        const body = input.body?.trim();
        const allowed =
          input.action === "approve"
            ? currentState.canApprove
            : input.action === "request_changes"
              ? currentState.canRequestChanges
              : currentState.canClear;
        const alreadyApplied =
          (input.action === "approve" &&
            currentState.decision === "approved") ||
          (input.action === "request_changes" &&
            currentState.decision === "changes_requested") ||
          (input.action === "clear" && currentState.decision === "none");
        if (alreadyApplied) {
          return {
            ...currentState,
            provider: scope.connection.provider,
            revisionCurrent: true,
            syncedAt: new Date(),
            unavailableReason: currentState.unavailableReason,
          };
        }
        if (!allowed) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              currentState.unavailableReason ??
              "The connected provider account cannot submit that review decision",
          });
        }
        if (
          input.action === "request_changes" &&
          currentState.requestChangesRequiresBody &&
          !body
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Add a reason before requesting changes",
          });
        }
        await provider.setPullRequestReviewDecision({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          headSha: scope.headSha,
          action: input.action,
          body,
        });
        const [updatedState, updatedPullRequest] = await Promise.all([
          provider.getPullRequestReviewState(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
          provider.getPullRequest(
            scope.repositoryExternalId,
            scope.pullRequestNumber,
          ),
        ]);
        if (
          updatedPullRequest.headSha !== scope.headSha ||
          updatedPullRequest.baseSha !== scope.baseSha
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The pull request changed while the review decision was being submitted. Synchronize it now.",
          });
        }
        return {
          ...updatedState,
          provider: scope.connection.provider,
          revisionCurrent: true,
          syncedAt: new Date(),
          unavailableReason: updatedState.unavailableReason,
        };
      } catch (cause) {
        throw providerOperationError(
          scope.connection.provider,
          cause,
          "review",
        );
      }
    }),

  poll: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-poll:${ctx.auth.userId}`,
        60,
        60_000,
      );
      const [current] = await ctx.db
        .select({
          repositoryId: repositories.id,
          workspaceId: repositories.workspaceId,
          number: pullRequests.number,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-poll-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );

      return {
        changed: true,
        ...(await startPullRequestSync(ctx.db, {
          workspaceId: current.workspaceId,
          repositoryId: current.repositoryId,
          pullRequestNumber: current.number,
        })),
      };
    }),

  reset: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-reset:${ctx.auth.userId}`,
        10,
        60_000,
      );
      const [current] = await ctx.db
        .select({
          repositoryId: repositories.id,
          workspaceId: repositories.workspaceId,
          number: pullRequests.number,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });

      const invalidated = await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${input.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        const activeSignOffs = await tx
          .select({ id: signOffs.id })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .where(
            and(
              eq(reviewSnapshots.pullRequestId, input.pullRequestId),
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
            ),
          );
        if (activeSignOffs.length > 0) {
          await tx
            .update(signOffs)
            .set({ invalidatedAt: new Date() })
            .where(
              inArray(
                signOffs.id,
                activeSignOffs.map(({ id }) => id),
              ),
            );
        }
        await tx
          .update(reviewSessions)
          .set({
            reviewedUnits: 0,
            experienceAwarded: 0,
          })
          .where(
            and(
              eq(reviewSessions.pullRequestId, input.pullRequestId),
              eq(reviewSessions.userId, ctx.auth.userId),
              isNull(reviewSessions.completedAt),
            ),
          );
        await recomputeReviewStats(tx, ctx.auth.userId);
        return activeSignOffs.length;
      });

      return {
        invalidated,
        ...(await startPullRequestSync(ctx.db, {
          workspaceId: current.workspaceId,
          repositoryId: current.repositoryId,
          pullRequestNumber: current.number,
        })),
      };
    }),

  providerConversations: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      // The reviewer-wide gate reads nothing the lookup produces, so the two
      // share one round trip.
      const [[scope]] = await Promise.all([
        ctx.db
          .select({
            pullRequestId: pullRequests.id,
            pullRequestNumber: pullRequests.number,
            repositoryExternalId: repositories.externalId,
            connection: providerConnections,
          })
          .from(pullRequests)
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            providerConnections,
            eq(repositories.connectionId, providerConnections.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
          .limit(1),
        enforceRateLimit(
          ctx.db,
          `review-conversations:${ctx.auth.userId}`,
          60,
          60_000,
        ),
      ]);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-conversations-resource:${ctx.auth.userId}:${input.pullRequestId}`,
        30,
        60_000,
      );

      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, scope.pullRequestId),
        orderBy: [desc(reviewSnapshots.version)],
      });
      if (!snapshot) {
        return {
          provider: scope.connection.provider,
          threads: [],
          syncedAt: new Date(),
          answeredUnitIds: [],
        };
      }
      const allUnits = await ctx.db
        .select({
          id: reviewUnits.id,
          path: reviewUnits.path,
          kind: reviewUnits.kind,
          startLine: reviewUnits.startLine,
          endLine: reviewUnits.endLine,
        })
        .from(reviewUnits)
        .where(eq(reviewUnits.snapshotId, snapshot.id));
      const units = allUnits.filter(({ kind }) => kind !== "file");
      const paths = new Set(units.map(({ path }) => path));
      try {
        const provider = await providerForConnection(ctx.db, scope.connection);
        const threads = await provider.listInlineCommentThreads(
          scope.repositoryExternalId,
          scope.pullRequestNumber,
        );
        const [waits, localComments] = units.length
          ? await Promise.all([
              ctx.db
                .select()
                .from(reviewWaits)
                .where(
                  and(
                    eq(reviewWaits.userId, ctx.auth.userId),
                    inArray(
                      reviewWaits.unitId,
                      units.map(({ id }) => id),
                    ),
                  ),
                ),
              ctx.db
                .select({
                  unitId: reviewComments.unitId,
                  userId: reviewComments.userId,
                  providerExternalId: reviewComments.providerExternalId,
                  providerCommentExternalId:
                    reviewComments.providerCommentExternalId,
                })
                .from(reviewComments)
                .where(
                  and(
                    eq(reviewComments.status, "published"),
                    inArray(
                      reviewComments.unitId,
                      units.map(({ id }) => id),
                    ),
                  ),
                ),
            ])
          : [[], []];
        // The provider attributes everything ReviewDuck posts to the one
        // workspace connection, so the conversation carries who actually
        // wrote each comment. A control the server would refuse should not
        // be offered in the first place.
        const publisherByProviderId = new Map(
          localComments.flatMap(
            ({ providerCommentExternalId, providerExternalId, userId }) => [
              ...(providerCommentExternalId
                ? [[providerCommentExternalId, userId] as const]
                : []),
              ...(providerExternalId
                ? [[providerExternalId, userId] as const]
                : []),
            ],
          ),
        );
        const explicitUnitByThreadId = new Map(
          localComments.flatMap((comment) =>
            comment.providerExternalId
              ? [[comment.providerExternalId, comment.unitId] as const]
              : [],
          ),
        );
        const assignedThreads = assignProviderThreadsToUnits(
          threads,
          units,
          explicitUnitByThreadId,
        );
        const unitById = new Map(units.map((unit) => [unit.id, unit]));
        const answeredUnitIds: string[] = [];
        for (const wait of waits) {
          const unit = unitById.get(wait.unitId);
          if (!unit) continue;
          const tracked = new Set(wait.providerThreadIds);
          const activity = providerActivityForUnit(
            assignedThreads.filter(
              (thread) =>
                thread.unitId === wait.unitId || tracked.has(thread.externalId),
            ),
            unit,
            wait.providerThreadIds,
          );
          if (
            hasNewProviderActivity(
              wait.observedCommentIds,
              activity.observedCommentIds,
            )
          ) {
            answeredUnitIds.push(wait.unitId);
          }
        }
        // The waits stay held: releasing them here would clear the waiting
        // state before the reviewer has seen what answered it. Only the unit
        // whose conversation moved is reported as answered — a sibling in the
        // same concept stays on the review path unless it was paused itself.
        const answeredWaits = waits.filter(({ unitId }) =>
          answeredUnitIds.includes(unitId),
        );
        return {
          provider: scope.connection.provider,
          threads: assignedThreads
            .filter((thread) => paths.has(thread.path))
            .map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment, index) => {
                // A root comment is recorded against the conversation it
                // opened; a reply against itself.
                const publisher =
                  publisherByProviderId.get(comment.externalId) ??
                  (index === 0
                    ? publisherByProviderId.get(thread.externalId)
                    : undefined);
                return {
                  ...comment,
                  body: visibleProviderCommentBody(comment.body),
                  // Absent means nobody here published it, which leaves it as
                  // open to change as the provider itself would leave it.
                  publishedByAnotherReviewer:
                    publisher !== undefined && publisher !== ctx.auth.userId,
                };
              }),
            })),
          syncedAt: new Date(),
          answeredUnitIds: answeredWaits.map(({ unitId }) => unitId),
        };
      } catch (cause) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: providerSyncErrorMessage(scope.connection.provider, cause),
          cause,
        });
      }
    }),

  awaitResponse: protectedProcedure
    .input(reviewUnitSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-await:${ctx.auth.userId}`,
        40,
        60_000,
      );
      await enforceRateLimit(
        ctx.db,
        `review-await-resource:${ctx.auth.userId}:${input.unitId}`,
        20,
        60_000,
      );
      const [wait] = await beginReviewWaits(ctx.db, ctx.auth.userId, [
        input.unitId,
      ]);
      if (!wait) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The waiting state could not be saved",
        });
      }
      return wait;
    }),

  /**
   * Takes back the waits one reviewer is holding.
   *
   * Deliberately free of the revision check every other concept action makes:
   * a reviewer whose pull request has moved on can neither sign off nor be
   * answered, so refusing to release here would be the one state with no way
   * out at all.
   */
  releaseReviewWaits: protectedProcedure
    .input(releaseReviewWaitsSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-release-wait:${ctx.auth.userId}`,
        40,
        60_000,
      );
      const accessible = await ctx.db
        .selectDistinct({ unitId: reviewUnits.id })
        .from(reviewUnits)
        .innerJoin(
          reviewSnapshots,
          eq(reviewUnits.snapshotId, reviewSnapshots.id),
        )
        .innerJoin(
          pullRequests,
          eq(reviewSnapshots.pullRequestId, pullRequests.id),
        )
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            inArray(reviewUnits.id, input.unitIds),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        );
      if (accessible.length === 0) throw new TRPCError({ code: "NOT_FOUND" });
      const released = await ctx.db
        .delete(reviewWaits)
        .where(
          and(
            eq(reviewWaits.userId, ctx.auth.userId),
            inArray(
              reviewWaits.unitId,
              accessible.map(({ unitId }) => unitId),
            ),
          ),
        )
        .returning({ unitId: reviewWaits.unitId });
      return {
        // Both, because a request can name a unit whose row another tab or a
        // poll already removed: it is deleted here by nobody, yet the caller
        // still believes it is paused and still has to be told otherwise.
        authorizedUnitIds: accessible.map(({ unitId }) => unitId),
        releasedUnitIds: released.map(({ unitId }) => unitId),
      };
    }),

  importTarget: protectedProcedure
    .input(importTargetSchema)
    .query(async ({ ctx, input }) => {
      const [scope] = await ctx.db
        .select({
          pullRequestId: pullRequests.id,
          repositoryExternalId: repositories.externalId,
          connection: providerConnections,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });

      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, scope.pullRequestId),
        orderBy: [desc(reviewSnapshots.version)],
      });
      if (!snapshot) throw new TRPCError({ code: "NOT_FOUND" });

      const candidates = importPathCandidates(
        input.sourcePath,
        input.specifier,
        input.sourceLanguage,
      );
      if (candidates.length === 0) {
        return {
          kind: "unresolved" as const,
          reason: "external" as const,
        };
      }

      const storedUnits = await hydrateReviewUnits(
        ctx.db,
        await ctx.db.query.reviewUnits.findMany({
          where: and(
            eq(reviewUnits.snapshotId, snapshot.id),
            inArray(reviewUnits.path, candidates),
          ),
          orderBy: [reviewUnits.reviewOrder],
        }),
      );
      const storedTarget = findImportTargetUnit(
        input.sourcePath,
        input.sourceLanguage,
        input,
        storedUnits,
      );
      if (storedTarget) {
        if (storedTarget.exactUnit) {
          return {
            kind: "unit" as const,
            unitId: storedTarget.exactUnit.id,
          };
        }
        const moduleUnit = storedTarget.moduleUnit;
        if (moduleUnit) {
          return {
            kind: "preview" as const,
            path: moduleUnit.path,
            language: moduleUnit.language,
            name: input.imported,
            source: moduleUnit.source,
            startLine: moduleUnit.startLine,
            endLine: moduleUnit.endLine,
            focusLine: findImportedDeclarationLine(
              moduleUnit.source,
              input.imported,
              moduleUnit.language,
              moduleUnit.startLine,
            ),
            inReviewPath: true,
          };
        }
      }

      const provider = await providerForConnection(ctx.db, scope.connection);
      for (const path of candidates) {
        let content: string | undefined;
        try {
          content = await provider.getFileContent(
            scope.repositoryExternalId,
            path,
            snapshot.headSha,
            150_000,
          );
        } catch (cause) {
          if (cause instanceof ProviderError && cause.status === 404) continue;
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message:
              "The imported source could not be loaded from the provider",
            cause,
          });
        }
        if (content === undefined) {
          return {
            kind: "unresolved" as const,
            reason: "too_large" as const,
          };
        }
        const analyzed = analyzeFiles([
          { path, content, changeType: "modified" },
        ]).units;
        const exactTarget =
          input.kind === "named"
            ? analyzed.find(
                (unit) =>
                  unit.kind !== "module" &&
                  unit.kind !== "file" &&
                  unit.name === input.imported,
              )
            : undefined;
        const target =
          exactTarget ??
          analyzed.find((unit) => unit.kind === "file") ??
          analyzed.find((unit) => unit.kind === "module");
        if (!target) continue;
        return {
          kind: "preview" as const,
          path,
          language: target.language,
          name: input.imported,
          source: target.source,
          startLine: target.startLine,
          endLine: target.endLine,
          focusLine:
            exactTarget?.startLine ??
            findImportedDeclarationLine(
              target.source,
              input.imported,
              target.language,
              target.startLine,
            ),
          inReviewPath: false,
        };
      }
      return {
        kind: "unresolved" as const,
        reason: "not_found" as const,
      };
    }),

  /**
   * Finds where a name used in the reviewed code is declared.
   *
   * A reviewer reading a call has to know what it does, and leaving the review
   * to find out is the expensive part. The whole file first answers local
   * declarations and identifies imports the browser has not parsed yet. A
   * known import is followed precisely; names without one can then use the
   * snapshot's unique repository-wide declaration as a safe fallback.
   */
  symbolDefinition: protectedProcedure
    .input(symbolDefinitionSchema)
    .query(async ({ ctx, input }) => {
      // Ahead of the lookup's own reads: a hover the reviewer is over budget
      // for should not pay for a scope and a snapshot query first.
      await enforceRateLimit(
        ctx.db,
        `review-symbol:${ctx.auth.userId}`,
        240,
        60_000,
      );
      const [scope] = await ctx.db
        .select({
          pullRequestId: pullRequests.id,
          repositoryExternalId: repositories.externalId,
          connection: providerConnections,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          providerConnections,
          eq(repositories.connectionId, providerConnections.id),
        )
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!scope) throw new TRPCError({ code: "NOT_FOUND" });
      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.pullRequestId, scope.pullRequestId),
        orderBy: [desc(reviewSnapshots.version)],
      });
      if (!snapshot) throw new TRPCError({ code: "NOT_FOUND" });

      const parsedFile = await parsedSymbolFile(ctx.db, snapshot.id, input);
      // Browser-side import parsing is progressive: a reviewer can hover a
      // value before its grammar has loaded. The stored full file is the
      // authoritative fallback, so imported variables do not depend on that
      // client timing while functions already indexed in the review work.
      const fileImport = parsedFile
        ? importReferenceForLocal(parsedFile.imports, input.symbol)
        : undefined;
      const resolvedInput =
        input.specifier || !fileImport
          ? input
          : {
              ...input,
              specifier: fileImport.specifier,
              imported: fileImport.imported,
              kind: fileImport.kind,
            };
      const read = { line: input.line, path: input.sourcePath };
      const analyzedDeclaration = parsedFile?.declarations.get(input.symbol);
      const local = localDefinitionForPeek(
        analyzedDeclaration,
        parsedFile &&
          (!analyzedDeclaration ||
            definitionIsWhereTheNameWasRead(analyzedDeclaration, read))
          ? sameFileDeclarationPeek({
              language: parsedFile.language,
              path: input.sourcePath,
              source: parsedFile.source,
              symbol: input.symbol,
            })
          : undefined,
        read,
      );
      const imported = resolvedInput.specifier
        ? await importedSymbolDefinition(
            ctx.db,
            ctx.auth.userId,
            { headSha: snapshot.headSha, id: snapshot.id },
            scope,
            resolvedInput,
          )
        : undefined;
      const found =
        local ??
        imported ??
        (await declaredSymbolInSnapshot(ctx.db, snapshot.id, input));
      if (!found) {
        return { kind: "unresolved" as const, reason: "not_found" as const };
      }
      if (found.kind === "unresolved") return found;
      if (
        definitionIsWhereTheNameWasRead(found, {
          line: input.line,
          path: input.sourcePath,
        })
      ) {
        return { kind: "unresolved" as const, reason: "self" as const };
      }
      return found;
    }),

  unitDiscussion: protectedProcedure
    .input(reviewUnitSchema)
    .query(async ({ ctx, input }) => {
      const [unit] = await ctx.db
        .select({
          id: reviewUnits.id,
          path: reviewUnits.path,
          startLine: reviewUnits.startLine,
          endLine: reviewUnits.endLine,
          changeType: reviewUnits.changeType,
          snapshotId: reviewUnits.snapshotId,
          pullRequestId: pullRequests.id,
        })
        .from(reviewUnits)
        .innerJoin(
          reviewSnapshots,
          eq(reviewUnits.snapshotId, reviewSnapshots.id),
        )
        .innerJoin(
          pullRequests,
          eq(reviewSnapshots.pullRequestId, pullRequests.id),
        )
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(reviewUnits.id, input.unitId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!unit) throw new TRPCError({ code: "NOT_FOUND" });

      const [comments, reviewJob, pathUnits] = await Promise.all([
        ctx.db.query.reviewComments.findMany({
          where: eq(reviewComments.unitId, unit.id),
          orderBy: [reviewComments.createdAt],
        }),
        ctx.db.query.aiJobs.findFirst({
          where: and(
            eq(aiJobs.pullRequestId, unit.pullRequestId),
            eq(aiJobs.snapshotId, unit.snapshotId),
            eq(aiJobs.userId, ctx.auth.userId),
            eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
            eq(aiJobs.kind, "review"),
            eq(aiJobs.status, "completed"),
            isNull(aiJobs.unitId),
          ),
          orderBy: [desc(aiJobs.createdAt)],
        }),
        ctx.db.query.reviewUnits.findMany({
          columns: {
            changeType: true,
            endLine: true,
            id: true,
            kind: true,
            relatedRanges: true,
            startLine: true,
          },
          where: and(
            eq(reviewUnits.snapshotId, unit.snapshotId),
            eq(reviewUnits.path, unit.path),
          ),
        }),
      ]);
      const findings =
        reviewJob?.result?.findings.flatMap((finding, index) => {
          if (finding.path !== unit.path || finding.line === undefined)
            return [];
          const target = pathUnits
            .filter(
              (candidate) =>
                finding.line !== undefined &&
                reviewUnitContainsLine(candidate, finding.line),
            )
            .sort((left, right) => {
              const spanDifference =
                left.endLine -
                left.startLine -
                (right.endLine - right.startLine);
              if (spanDifference !== 0) return spanDifference;
              const leftRank =
                left.kind === "file" ? 2 : left.kind === "module" ? 1 : 0;
              const rightRank =
                right.kind === "file" ? 2 : right.kind === "module" ? 1 : 0;
              return leftRank - rightRank;
            })[0];
          return target?.id === unit.id
            ? [{ ...finding, index, aiJobId: reviewJob.id }]
            : [];
        }) ?? [];
      return { comments, findings };
    }),

  deepReviewFindings: protectedProcedure
    .input(reviewWorkspaceSchema)
    .query(async ({ ctx, input }) => {
      const [accessible] = await ctx.db
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(accessiblePullRequest(ctx.auth.userId, input.pullRequestId))
        .limit(1);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });

      const snapshot = await ctx.db.query.reviewSnapshots.findFirst({
        columns: { id: true },
        where: eq(reviewSnapshots.pullRequestId, input.pullRequestId),
        orderBy: [desc(reviewSnapshots.version)],
      });
      if (!snapshot) return null;

      // The same scope `ai.reviewStatus` resolves a run by, and the only one
      // the findings below inherit: a deep-review parent is the reviewer's own
      // run against this revision, and `parentJobId` excludes its children.
      const job = await ctx.db.query.aiJobs.findFirst({
        columns: {
          id: true,
          status: true,
          createdAt: true,
          completedAt: true,
          completionReason: true,
          deepReviewTerminalState: true,
          runFailureClass: true,
          error: true,
        },
        where: and(
          eq(aiJobs.pullRequestId, input.pullRequestId),
          eq(aiJobs.snapshotId, snapshot.id),
          eq(aiJobs.userId, ctx.auth.userId),
          eq(aiJobs.agentVersion, CURRENT_AI_AGENT_VERSION),
          eq(aiJobs.kind, "review"),
          isNull(aiJobs.unitId),
          isNull(aiJobs.parentJobId),
        ),
        orderBy: [desc(aiJobs.createdAt)],
      });
      if (!job) return null;
      return await deepReviewRunPayload(ctx.db, job);
    }),

  publishComment: protectedProcedure
    .input(publishReviewCommentSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await providerScopeForUnit(
        ctx.db,
        ctx.auth.userId,
        input.unitId,
        "Synchronize the pull request before publishing a comment",
      );
      if (!reviewUnitContainsLine(scope, input.line)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The selected line is outside this review unit",
        });
      }

      let body = input.body;
      let source: "user" | "ai" = "user";
      let aiResultIndex = input.aiFindingIndex ?? input.aiCommentIndex;
      if (
        input.aiJobId !== undefined &&
        (aiResultIndex !== undefined || input.aiFindingId !== undefined)
      ) {
        source = "ai";
        const job = await ctx.db.query.aiJobs.findFirst({
          where: and(
            eq(aiJobs.id, input.aiJobId),
            eq(aiJobs.userId, ctx.auth.userId),
            eq(aiJobs.pullRequestId, scope.pullRequestId),
            eq(aiJobs.snapshotId, scope.snapshotId),
            eq(aiJobs.status, "completed"),
          ),
        });
        if (input.aiFindingId !== undefined) {
          // Authorization is the job lookup above, unchanged; the row
          // predicates below only establish that the finding still describes
          // this line.
          if (job?.kind !== "review" || job.parentJobId !== null) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This AI finding does not belong to the selected review",
            });
          }
          const finding = await deepReviewFindingForPublication(ctx.db, {
            findingId: input.aiFindingId,
            parentJobId: job.id,
            path: scope.path,
            line: input.line,
          });
          body = finding.body;
          aiResultIndex = finding.orderIndex;
        } else if (input.aiFindingIndex !== undefined) {
          const finding = job?.result?.findings[input.aiFindingIndex];
          if (
            job?.kind !== "review" ||
            !finding ||
            finding.path !== scope.path ||
            finding.line !== input.line
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This AI finding no longer matches the selected code",
            });
          }
          body = `**${finding.title}**\n\n${finding.body}`;
        } else {
          const proposal =
            job?.result?.commentProposals?.[input.aiCommentIndex ?? -1];
          if (
            job?.kind !== "explain" ||
            !job.question ||
            !proposal ||
            proposal.path !== scope.path ||
            proposal.line !== input.line
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This AI comment proposal no longer matches the selected code",
            });
          }
          body = input.body ?? proposal.body;
        }
      }
      if (!body) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Comment text is required",
        });
      }

      let retryingPublication = false;
      let comment =
        source === "user"
          ? await findEquivalentUserComment(ctx.db, {
              unitId: scope.unitId,
              userId: ctx.auth.userId,
              body,
              line: input.line,
            })
          : undefined;
      const equivalentUserCommentFound = comment !== undefined;
      if (comment?.status === "published") return comment;
      if (comment?.status === "failed" || comment?.status === "publishing") {
        comment = await claimCommentForPublicationRetry(ctx.db, comment.id);
        retryingPublication = comment !== undefined;
      }
      if (!comment && !equivalentUserCommentFound) {
        const publicationLeaseToken = randomUUID();
        [comment] = await ctx.db
          .insert(reviewComments)
          .values({
            unitId: scope.unitId,
            userId: ctx.auth.userId,
            aiJobId: input.aiJobId,
            aiFindingIndex: aiResultIndex,
            source,
            body,
            line: input.line,
            status: "publishing",
            publicationLeaseToken,
          })
          .onConflictDoNothing()
          .returning();
      }
      if (!comment) {
        comment =
          input.aiJobId !== undefined
            ? await ctx.db.query.reviewComments.findFirst({
                where: and(
                  eq(reviewComments.aiJobId, input.aiJobId),
                  eq(reviewComments.aiFindingIndex, aiResultIndex ?? -1),
                ),
              })
            : undefined;
        if (comment?.status === "published") return comment;
        if (comment?.status === "failed" || comment?.status === "publishing") {
          comment = await claimCommentForPublicationRetry(ctx.db, comment.id);
          retryingPublication = comment !== undefined;
        }
      }
      if (!comment) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This comment is already being published",
        });
      }
      if (!comment.publicationLeaseToken) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This comment publication lease is unavailable",
        });
      }
      const publicationLeaseToken = comment.publicationLeaseToken;

      try {
        const provider = await providerForConnection(ctx.db, scope.connection);
        const existingThread = retryingPublication
          ? publishedThreadForComment(
              await provider.listInlineCommentThreads(
                scope.repositoryExternalId,
                scope.pullRequestNumber,
              ),
              comment.id,
            )
          : undefined;
        const published = existingThread
          ? { externalId: existingThread.externalId }
          : await provider.publishInlineComment({
              repositoryExternalId: scope.repositoryExternalId,
              pullRequestNumber: scope.pullRequestNumber,
              headSha: scope.headSha,
              path: scope.path,
              line: input.line,
              side: scope.changeType === "deleted" ? "left" : "right",
              body: providerCommentBody(body, comment.id),
              idempotencyKey: publicationAttemptKey(comment.id),
            });
        const [updated] = await ctx.db
          .update(reviewComments)
          .set({
            status: "published",
            providerExternalId: published.externalId,
            publicationLeaseToken: null,
            error: null,
            publishedAt: new Date(),
          })
          .where(
            and(
              eq(reviewComments.id, comment.id),
              eq(reviewComments.status, "publishing"),
              eq(reviewComments.publicationLeaseToken, publicationLeaseToken),
            ),
          )
          .returning();
        if (!updated) {
          throw new Error("Comment publication lease was superseded");
        }
        return updated;
      } catch (cause) {
        const message = providerSyncErrorMessage(
          scope.connection.provider,
          cause,
        );
        await ctx.db
          .update(reviewComments)
          .set({
            status: "failed",
            publicationLeaseToken: null,
            error: message,
          })
          .where(
            and(
              eq(reviewComments.id, comment.id),
              eq(reviewComments.status, "publishing"),
              eq(reviewComments.publicationLeaseToken, publicationLeaseToken),
            ),
          );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message,
          cause,
        });
      }
    }),

  replyToThread: protectedProcedure
    .input(replyToReviewThreadSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-reply",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        const parentCommentExternalId = thread.comments[0]?.externalId;
        if (!parentCommentExternalId) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message:
              "This provider conversation is no longer attached to the current review unit",
          });
        }
        const reply = await provider.replyToInlineThread({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          parentCommentExternalId,
          body: input.body,
        });
        // A reply opens no conversation, so this row exists to say who wrote
        // it. Without it the reply would be the one thing ReviewDuck posts
        // that any other member could rewrite or remove.
        await ctx.db.insert(reviewComments).values({
          unitId: input.unitId,
          userId: ctx.auth.userId,
          source: "user",
          body: input.body,
          line: thread.line,
          status: "published",
          providerCommentExternalId: reply.externalId,
          publishedAt: new Date(),
        });
        return reply;
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  setThreadResolution: protectedProcedure
    .input(resolveReviewThreadSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-resolve-thread",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        await provider.setInlineThreadResolution({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          resolved: input.resolved,
        });
        return { resolved: input.resolved };
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  editThreadComment: protectedProcedure
    .input(editReviewThreadCommentSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-edit-comment",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        const edited = thread.comments.find(
          ({ externalId }) => externalId === input.commentExternalId,
        );
        if (!edited) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That comment is no longer part of this conversation",
          });
        }
        await assertCommentIsTheReviewersToChange(
          ctx.db,
          ctx.auth.userId,
          input.unitId,
          thread,
          input.commentExternalId,
        );
        await provider.editInlineComment({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          commentExternalId: input.commentExternalId,
          body: rewrittenProviderCommentBody(edited.body, input.body),
        });
        // A root comment is recorded against the conversation it opened and
        // a reply against itself, so the rewrite has to follow whichever key
        // the ledger holds it under.
        const conversationId = publishedCommentId(
          thread,
          input.commentExternalId,
        );
        await ctx.db
          .update(reviewComments)
          .set({ body: input.body })
          .where(
            and(
              eq(reviewComments.unitId, input.unitId),
              conversationId
                ? or(
                    eq(reviewComments.providerExternalId, conversationId),
                    eq(
                      reviewComments.providerCommentExternalId,
                      input.commentExternalId,
                    ),
                  )
                : eq(
                    reviewComments.providerCommentExternalId,
                    input.commentExternalId,
                  ),
            ),
          );
        return { edited: true };
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  deleteThreadComment: protectedProcedure
    .input(reviewThreadCommentSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-delete-comment",
      );
      try {
        const thread = await attachedProviderThread(provider, scope, input);
        if (
          !thread.comments.some(
            ({ externalId }) => externalId === input.commentExternalId,
          )
        ) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That comment is no longer part of this conversation",
          });
        }
        await assertCommentIsTheReviewersToChange(
          ctx.db,
          ctx.auth.userId,
          input.unitId,
          thread,
          input.commentExternalId,
        );
        await provider.deleteInlineComment({
          repositoryExternalId: scope.repositoryExternalId,
          pullRequestNumber: scope.pullRequestNumber,
          threadExternalId: thread.externalId,
          commentExternalId: input.commentExternalId,
        });
        await forgetPublishedComments(ctx.db, input.unitId, {
          conversationIds: [
            publishedCommentId(thread, input.commentExternalId),
          ],
          commentIds: [input.commentExternalId],
        });
        return { deleted: 1 };
      } catch (cause) {
        throw providerThreadError(scope.connection.provider, cause);
      }
    }),

  deleteThread: protectedProcedure
    .input(reviewThreadSchema)
    .mutation(async ({ ctx, input }) => {
      const { provider, scope } = await reviewThreadScope(
        ctx.db,
        ctx.auth.userId,
        input,
        "review-delete-thread",
      );
      const thread = await attachedProviderThread(provider, scope, input).catch(
        (cause: unknown) => {
          throw providerThreadError(scope.connection.provider, cause);
        },
      );
      // Deleting a conversation takes every comment in it, so each one has to
      // be the reviewer's to take.
      for (const comment of thread.comments) {
        await assertCommentIsTheReviewersToChange(
          ctx.db,
          ctx.auth.userId,
          input.unitId,
          thread,
          comment.externalId,
        );
      }
      // Replies first: no provider lets the comment a conversation hangs
      // from leave while the conversation still holds answers to it.
      const ordered = [...thread.comments].reverse();
      const removed: string[] = [];
      try {
        for (const comment of ordered) {
          await provider.deleteInlineComment({
            repositoryExternalId: scope.repositoryExternalId,
            pullRequestNumber: scope.pullRequestNumber,
            threadExternalId: thread.externalId,
            commentExternalId: comment.externalId,
          });
          removed.push(comment.externalId);
        }
      } catch (cause) {
        // A conversation is deleted one comment at a time, so a failure part
        // way through leaves comments already gone at the provider. The ledger
        // is what tells the reviewer a comment is still posted, so it gives the
        // conversation up as soon as the comment it hangs from has left.
        await forgetPublishedComments(ctx.db, input.unitId, {
          conversationIds: removed.some(
            (externalId) =>
              publishedCommentId(thread, externalId) !== undefined,
          )
            ? [thread.externalId]
            : [],
          commentIds: removed,
        });
        throw providerThreadError(scope.connection.provider, cause);
      }
      await forgetPublishedComments(ctx.db, input.unitId, {
        conversationIds: [thread.externalId],
        commentIds: removed,
      });
      return { deleted: removed.length };
    }),

  beginSession: protectedProcedure
    .input(reviewWorkspaceSchema)
    .mutation(async ({ ctx, input }) => {
      const [accessible] = await ctx.db
        .select({ snapshotId: reviewSnapshots.id })
        .from(reviewSnapshots)
        .innerJoin(
          pullRequests,
          eq(reviewSnapshots.pullRequestId, pullRequests.id),
        )
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(pullRequests.id, input.pullRequestId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .orderBy(desc(reviewSnapshots.version))
        .limit(1);
      if (!accessible) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${accessible.snapshotId}:${ctx.auth.userId}:session`}))`,
        );
        const existing = await tx.query.reviewSessions.findFirst({
          where: and(
            eq(reviewSessions.pullRequestId, input.pullRequestId),
            eq(reviewSessions.snapshotId, accessible.snapshotId),
            eq(reviewSessions.userId, ctx.auth.userId),
            isNull(reviewSessions.completedAt),
          ),
        });
        if (existing) return existing;
        const [session] = await tx
          .insert(reviewSessions)
          .values({
            pullRequestId: input.pullRequestId,
            snapshotId: accessible.snapshotId,
            userId: ctx.auth.userId,
          })
          .returning();
        return session;
      });
    }),

  sync: protectedProcedure
    .input(syncPullRequestSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `review-sync:${ctx.auth.userId}`,
        40,
        60_000,
      );
      const [access] = await ctx.db
        .select({
          id: repositories.id,
          workspaceId: repositories.workspaceId,
        })
        .from(repositories)
        .innerJoin(
          workspaceMembers,
          eq(repositories.workspaceId, workspaceMembers.workspaceId),
        )
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!access) throw new TRPCError({ code: "NOT_FOUND" });
      await enforceRateLimit(
        ctx.db,
        `review-sync-resource:${ctx.auth.userId}:${input.repositoryId}`,
        20,
        60_000,
      );
      return startPullRequestSync(ctx.db, {
        workspaceId: access.workspaceId,
        repositoryId: access.id,
        pullRequestNumber: input.number,
        queue: {
          userId: ctx.auth.userId,
          source: "manual",
          explicit: true,
        },
      });
    }),

  syncStatus: protectedProcedure
    .input(z.object({ syncId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [sync] = await ctx.db
        .select({ sync: syncRuns, providerRunId: workflowRuns.providerRunId })
        .from(syncRuns)
        .innerJoin(
          workspaceMembers,
          eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
        )
        .leftJoin(workflowRuns, eq(syncRuns.workflowRunId, workflowRuns.id))
        .where(
          and(
            eq(syncRuns.id, input.syncId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!sync) throw new TRPCError({ code: "NOT_FOUND" });
      return { ...sync.sync, providerRunId: sync.providerRunId };
    }),

  activeSyncs: protectedProcedure.query(async ({ ctx }) =>
    ctx.db
      .select({
        id: syncRuns.id,
        repositoryId: syncRuns.repositoryId,
        pullRequestNumber: syncRuns.pullRequestNumber,
        status: syncRuns.status,
        progress: syncRuns.progress,
        createdAt: syncRuns.createdAt,
        startedAt: syncRuns.startedAt,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        provider: providerConnections.provider,
        title: pullRequests.title,
      })
      .from(syncRuns)
      .innerJoin(repositories, eq(syncRuns.repositoryId, repositories.id))
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .leftJoin(
        pullRequests,
        and(
          eq(pullRequests.repositoryId, syncRuns.repositoryId),
          eq(pullRequests.number, syncRuns.pullRequestNumber),
        ),
      )
      .innerJoin(
        workspaceMembers,
        eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
      )
      .where(
        and(
          eq(workspaceMembers.userId, ctx.auth.userId),
          inArray(syncRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(syncRuns.createdAt)),
  ),

  recentSyncFailures: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: syncRuns.id,
        repositoryId: syncRuns.repositoryId,
        pullRequestNumber: syncRuns.pullRequestNumber,
        status: syncRuns.status,
        progress: syncRuns.progress,
        createdAt: syncRuns.createdAt,
        completedAt: syncRuns.completedAt,
        repositoryOwner: repositories.owner,
        repositoryName: repositories.name,
        provider: providerConnections.provider,
        connectionUpdatedAt: providerConnections.updatedAt,
        title: pullRequests.title,
        error: syncRuns.error,
      })
      .from(syncRuns)
      .innerJoin(repositories, eq(syncRuns.repositoryId, repositories.id))
      .innerJoin(
        providerConnections,
        eq(repositories.connectionId, providerConnections.id),
      )
      .leftJoin(
        pullRequests,
        and(
          eq(pullRequests.repositoryId, syncRuns.repositoryId),
          eq(pullRequests.number, syncRuns.pullRequestNumber),
        ),
      )
      .innerJoin(
        workspaceMembers,
        eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
      )
      .where(
        and(
          eq(workspaceMembers.userId, ctx.auth.userId),
          gte(syncRuns.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1_000)),
        ),
      )
      .orderBy(desc(syncRuns.createdAt))
      .limit(100);

    const seenPullRequests = new Set<string>();
    const failures = [];
    for (const row of rows) {
      const key = `${row.repositoryId}:${row.pullRequestNumber}`;
      if (seenPullRequests.has(key)) continue;
      seenPullRequests.add(key);
      if (row.status !== "failed") continue;
      if (connectionUpdateResolvesSyncFailure(row, row.connectionUpdatedAt)) {
        continue;
      }
      failures.push({
        id: row.id,
        repositoryId: row.repositoryId,
        pullRequestNumber: row.pullRequestNumber,
        status: row.status,
        progress: row.progress,
        completedAt: row.completedAt,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        provider: row.provider,
        title: row.title,
        message: persistedSyncErrorMessage(row.provider, row.error),
      });
      if (failures.length === 3) break;
    }
    return failures;
  }),

  cancelSync: protectedProcedure
    .input(z.object({ syncId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [sync] = await ctx.db
        .select({ runId: workflowRuns.providerRunId })
        .from(syncRuns)
        .innerJoin(
          workspaceMembers,
          eq(syncRuns.workspaceId, workspaceMembers.workspaceId),
        )
        .innerJoin(workflowRuns, eq(syncRuns.workflowRunId, workflowRuns.id))
        .where(
          and(
            eq(syncRuns.id, input.syncId),
            eq(workspaceMembers.userId, ctx.auth.userId),
          ),
        )
        .limit(1);
      if (!sync) throw new TRPCError({ code: "NOT_FOUND" });
      await cancelWorkflowRun(ctx.db, sync.runId);
      await ctx.db
        .update(syncRuns)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(syncRuns.id, input.syncId));
      return { status: "cancelled" as const };
    }),

  improveConceptGrouping: protectedProcedure
    .input(improveConceptGroupingSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `semantic-clustering:${ctx.auth.userId}`,
        5,
        60 * 60_000,
      );
      try {
        const planTier = managedAiPlanTier((feature) =>
          ctx.auth.has({ feature }),
        );
        return await proposeSemanticConceptLayout(ctx.db, {
          ...input,
          userId: ctx.auth.userId,
          subscribed: planTier !== "free",
          planTier,
        });
      } catch (cause) {
        console.error("Semantic review grouping failed", cause);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            cause instanceof Error &&
            [
              "The review concept layout changed or is locked",
              "A newer personal review concept layout is active",
              "AI grouping did not return a complete review partition",
              SEMANTIC_CLUSTER_TOO_LARGE,
              SEMANTIC_CLUSTER_TIMED_OUT,
            ].includes(cause.message)
              ? cause.message
              : "AI could not improve this grouping. The current layout was not changed.",
        });
      }
    }),

  replacePersonalConceptLayout: protectedProcedure
    .input(replacePersonalConceptLayoutSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(
        ctx.db,
        `concept-layout:${ctx.auth.userId}`,
        60,
        60_000,
      );
      return ctx.db.transaction(async (tx) => {
        await lockConceptLayoutScope(tx, ctx.auth.userId, input.snapshotId);
        const [snapshot] = await tx
          .select({
            id: reviewSnapshots.id,
            createdAt: reviewSnapshots.createdAt,
          })
          .from(reviewSnapshots)
          .innerJoin(
            pullRequests,
            eq(reviewSnapshots.pullRequestId, pullRequests.id),
          )
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(
            and(
              eq(reviewSnapshots.id, input.snapshotId),
              eq(pullRequests.id, input.pullRequestId),
              eq(reviewSnapshots.headSha, pullRequests.headSha),
              eq(reviewSnapshots.baseSha, pullRequests.baseSha),
              eq(workspaceMembers.userId, ctx.auth.userId),
            ),
          )
          .limit(1);
        if (!snapshot) throw new TRPCError({ code: "NOT_FOUND" });
        const newSignOff = await tx
          .select({ id: signOffs.id })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .where(
            and(
              eq(reviewUnits.snapshotId, snapshot.id),
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              gte(signOffs.signedOffAt, snapshot.createdAt),
            ),
          )
          .limit(1);
        if (newSignOff.length > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Concept grouping is locked after the first sign-off on this revision.",
          });
        }
        const layouts = await tx
          .select()
          .from(reviewConceptLayouts)
          .where(
            and(
              eq(reviewConceptLayouts.snapshotId, snapshot.id),
              or(
                eq(reviewConceptLayouts.userId, ctx.auth.userId),
                isNull(reviewConceptLayouts.userId),
              ),
            ),
          );
        const personal = layouts.find(
          ({ userId }) => userId === ctx.auth.userId,
        );
        const baseline = layouts.find(({ userId }) => userId === null);
        const active = personal ?? baseline;
        if (!active || active.version !== input.expectedVersion) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The review concept layout changed. Reload and try again.",
          });
        }
        if (personal?.lockedAt) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Concept grouping is locked after the first sign-off on this revision.",
          });
        }
        const units = await tx
          .select({
            id: reviewUnits.id,
            stableKey: reviewUnits.stableKey,
            path: reviewUnits.path,
            changedLineCount: reviewUnits.changedLineCount,
            reviewOrder: reviewUnits.reviewOrder,
          })
          .from(reviewUnits)
          .where(
            and(
              eq(reviewUnits.snapshotId, snapshot.id),
              sql`${reviewUnits.kind} <> 'file'`,
            ),
          );
        const byId = new Map(units.map((unit) => [unit.id, unit]));
        const seen = new Set<string>();
        for (const concept of input.concepts) {
          const members = concept.memberUnitIds.map((id) => {
            const unit = byId.get(id);
            if (!unit) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Unknown review unit ${id}`,
              });
            }
            if (seen.has(id)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "A review unit can appear in only one concept.",
              });
            }
            seen.add(id);
            return unit;
          });
          const files = new Set(members.map(({ path }) => path)).size;
          const changedLines = members.reduce(
            (total, unit) => total + unit.changedLineCount,
            0,
          );
          if (
            members.length > 1 &&
            (files > MAX_CONCEPT_FILES ||
              changedLines > MAX_CONCEPT_CHANGED_LINES)
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Concepts are limited to ${MAX_CONCEPT_FILES} files and ${MAX_CONCEPT_CHANGED_LINES} changed lines.`,
            });
          }
        }
        if (seen.size !== units.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Every atomic review unit must belong to exactly one concept.",
          });
        }
        const nextVersion = active.version + 1;
        let layoutId: string;
        if (personal) {
          const [updated] = await tx
            .update(reviewConceptLayouts)
            .set({ source: input.source, version: nextVersion })
            .where(
              and(
                eq(reviewConceptLayouts.id, personal.id),
                eq(reviewConceptLayouts.version, input.expectedVersion),
                isNull(reviewConceptLayouts.lockedAt),
              ),
            )
            .returning({ id: reviewConceptLayouts.id });
          if (!updated) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "The review concept layout changed. Reload and try again.",
            });
          }
          layoutId = updated.id;
          await tx
            .delete(reviewConcepts)
            .where(eq(reviewConcepts.layoutId, layoutId));
        } else {
          const [created] = await tx
            .insert(reviewConceptLayouts)
            .values({
              snapshotId: snapshot.id,
              userId: ctx.auth.userId,
              source: input.source,
              version: nextVersion,
            })
            .returning({ id: reviewConceptLayouts.id });
          if (!created)
            throw new Error("Personal concept layout was not saved");
          layoutId = created.id;
        }
        const definitions = input.concepts
          .map((concept) => {
            const members = concept.memberUnitIds
              .map((id) => byId.get(id))
              .filter((unit): unit is (typeof units)[number] => Boolean(unit))
              .sort(
                (left, right) =>
                  left.reviewOrder - right.reviewOrder ||
                  left.stableKey.localeCompare(right.stableKey),
              );
            const changedLineCount = members.reduce(
              (total, unit) => total + unit.changedLineCount,
              0,
            );
            return {
              stableKey: `concept:${sha256(
                members
                  .map(({ stableKey }) => stableKey)
                  .sort()
                  .join("\0"),
              )}`,
              title: concept.title,
              rationale: concept.rationale,
              reviewOrder: Math.min(
                ...members.map(({ reviewOrder }) => reviewOrder),
              ),
              changedLineCount,
              fileCount: new Set(members.map(({ path }) => path)).size,
              oversized:
                members.length === 1 &&
                changedLineCount > MAX_CONCEPT_CHANGED_LINES,
              memberUnitIds: members.map(({ id }) => id),
            };
          })
          .sort(
            (left, right) =>
              left.reviewOrder - right.reviewOrder ||
              left.stableKey.localeCompare(right.stableKey),
          );
        const atomicDependencies = await tx
          .select()
          .from(reviewUnitDependencies)
          .where(
            inArray(
              reviewUnitDependencies.unitId,
              units.map(({ id }) => id),
            ),
          );
        const conceptKeyByUnit = new Map(
          definitions.flatMap((definition) =>
            definition.memberUnitIds.map(
              (unitId) => [unitId, definition.stableKey] as const,
            ),
          ),
        );
        const dependencyKeys = new Map<string, Set<string>>();
        for (const dependency of atomicDependencies) {
          const conceptKey = conceptKeyByUnit.get(dependency.unitId);
          const dependencyKey = conceptKeyByUnit.get(dependency.dependencyId);
          if (!conceptKey || !dependencyKey || conceptKey === dependencyKey) {
            continue;
          }
          dependencyKeys.set(
            conceptKey,
            (dependencyKeys.get(conceptKey) ?? new Set()).add(dependencyKey),
          );
        }
        // Grouping can invert the atomic review order, so emit dependencies
        // ahead of their dependents exactly as the deterministic layout does.
        const definitionByKey = new Map(
          definitions.map((definition) => [definition.stableKey, definition]),
        );
        const emitted = new Set<string>();
        const visiting = new Set<string>();
        const ordered: typeof definitions = [];
        /** Emits dependencies before the dependent concept, condensing cycles safely. */
        const visit = (definition: (typeof definitions)[number]) => {
          if (
            emitted.has(definition.stableKey) ||
            visiting.has(definition.stableKey)
          ) {
            return;
          }
          visiting.add(definition.stableKey);
          [...(dependencyKeys.get(definition.stableKey) ?? [])]
            .map((key) => definitionByKey.get(key))
            .filter((value): value is (typeof definitions)[number] =>
              Boolean(value),
            )
            .sort(
              (left, right) =>
                left.reviewOrder - right.reviewOrder ||
                left.stableKey.localeCompare(right.stableKey),
            )
            .forEach(visit);
          visiting.delete(definition.stableKey);
          emitted.add(definition.stableKey);
          ordered.push(definition);
        };
        for (const definition of definitions) visit(definition);
        const createdConcepts = await tx
          .insert(reviewConcepts)
          .values(
            ordered.map((concept, reviewOrder) => ({
              layoutId,
              stableKey: concept.stableKey,
              title: concept.title,
              rationale: concept.rationale,
              reviewOrder,
              changedLineCount: concept.changedLineCount,
              fileCount: concept.fileCount,
              oversized: concept.oversized,
            })),
          )
          .returning({
            id: reviewConcepts.id,
            stableKey: reviewConcepts.stableKey,
          });
        const conceptByKey = new Map(
          createdConcepts.map((concept) => [concept.stableKey, concept]),
        );
        await tx.insert(reviewConceptMembers).values(
          ordered.flatMap((definition) => {
            const concept = conceptByKey.get(definition.stableKey);
            if (!concept) return [];
            return definition.memberUnitIds.map((unitId, memberOrder) => ({
              layoutId,
              conceptId: concept.id,
              unitId,
              snapshotId: snapshot.id,
              memberOrder,
            }));
          }),
        );
        const collapsedDependencies = [...dependencyKeys].flatMap(
          ([conceptKey, dependsOn]) => {
            const concept = conceptByKey.get(conceptKey);
            if (!concept) return [];
            return [...dependsOn].flatMap((key) => {
              const dependency = conceptByKey.get(key);
              return dependency
                ? [
                    {
                      layoutId,
                      conceptId: concept.id,
                      dependencyId: dependency.id,
                    },
                  ]
                : [];
            });
          },
        );
        if (collapsedDependencies.length > 0) {
          await tx
            .insert(reviewConceptDependencies)
            .values(collapsedDependencies);
        }
        return { layoutId, version: nextVersion, source: input.source };
      });
    }),

  signOffConcept: protectedProcedure
    .input(signOffConceptSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const snapshotId = await conceptLayoutSnapshotId(tx, input.layoutId);
        await lockConceptLayoutScope(tx, ctx.auth.userId, snapshotId);
        await assertSnapshotIsCurrent(
          tx,
          snapshotId,
          "Synchronize the pull request before signing off this concept",
        );
        const concept = await conceptMembersForMutation(
          tx,
          ctx.auth.userId,
          input,
        );
        const waiting = await tx
          .select({ unitId: reviewWaits.unitId })
          .from(reviewWaits)
          .where(
            and(
              eq(reviewWaits.userId, ctx.auth.userId),
              inArray(
                reviewWaits.unitId,
                concept.members.map(({ id }) => id),
              ),
            ),
          )
          .limit(1);
        if (waiting.length > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This concept is waiting for a provider response and cannot be signed off yet.",
          });
        }
        const complexity = concept.members.reduce(
          (total, member) => total + Math.max(1, member.complexity),
          0,
        );
        let allocated = 0;
        const memberInputs = concept.members.map((member, index) => {
          const durationSeconds =
            index === concept.members.length - 1
              ? input.durationSeconds - allocated
              : Math.floor(
                  (input.durationSeconds * Math.max(1, member.complexity)) /
                    complexity,
                );
          allocated += durationSeconds;
          return {
            unitId: member.id,
            sessionId: input.sessionId,
            note: input.note,
            durationSeconds,
          };
        });
        const outcomes = await persistSignOffs(
          tx,
          ctx.auth.userId,
          memberInputs,
        );
        const writes: PersistedSignOff[] = [];
        for (const { unitId } of memberInputs) {
          const outcome = outcomes.get(unitId);
          if (!outcome) throw new TRPCError({ code: "NOT_FOUND" });
          if (!outcome.ok) throw signOffFailure(outcome);
          writes.push(outcome.write);
        }
        await finalizeSignOffs(tx, ctx.auth.userId, writes);
        await lockConceptLayoutForReviewer(tx, ctx.auth.userId, concept);
        return {
          conceptId: concept.conceptId,
          signedUnitIds: writes.map(({ signOff }) => signOff.unitId),
        };
      }),
    ),

  unreviewConcept: protectedProcedure
    .input(unreviewConceptSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const snapshotId = await conceptLayoutSnapshotId(tx, input.layoutId);
        await lockConceptLayoutScope(tx, ctx.auth.userId, snapshotId);
        await assertSnapshotIsCurrent(
          tx,
          snapshotId,
          "Synchronize the pull request before undoing this concept",
        );
        const concept = await conceptMembersForMutation(
          tx,
          ctx.auth.userId,
          input,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${concept.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        const active = await tx
          .select({
            id: signOffs.id,
            unitId: signOffs.unitId,
            signedOffAt: signOffs.signedOffAt,
            durationSeconds: signOffs.durationSeconds,
            complexity: reviewUnits.complexity,
          })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .where(
            and(
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              inArray(
                signOffs.unitId,
                concept.members.map(({ id }) => id),
              ),
            ),
          );
        if (active.length === 0) return { unreviewed: false, unitIds: [] };
        await tx
          .update(signOffs)
          .set({ invalidatedAt: new Date() })
          .where(
            inArray(
              signOffs.id,
              active.map(({ id }) => id),
            ),
          );
        if (input.sessionId) {
          const session = await tx.query.reviewSessions.findFirst({
            where: and(
              eq(reviewSessions.id, input.sessionId),
              eq(reviewSessions.userId, ctx.auth.userId),
              eq(reviewSessions.snapshotId, concept.snapshotId),
            ),
          });
          if (session) {
            const inSession = active.filter(
              ({ signedOffAt }) => signedOffAt >= session.startedAt,
            );
            const experience = inSession.reduce(
              (total, signOff) =>
                total +
                reviewExperience(signOff.complexity, signOff.durationSeconds),
              0,
            );
            await tx
              .update(reviewSessions)
              .set({
                reviewedUnits: sql`greatest(${reviewSessions.reviewedUnits} - ${inSession.length}, 0)`,
                experienceAwarded: sql`greatest(${reviewSessions.experienceAwarded} - ${experience}, 0)`,
                completedAt: null,
              })
              .where(eq(reviewSessions.id, session.id));
          }
        }
        await recomputeReviewStats(tx, ctx.auth.userId);
        return {
          unreviewed: true,
          unitIds: active.map(({ unitId }) => unitId),
        };
      }),
    ),

  signOffFile: protectedProcedure
    .input(reviewFileActionSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const file = await currentSnapshotFileForMember(
          tx,
          ctx.auth.userId,
          input.snapshotFileId,
        );
        if (!file) throw new TRPCError({ code: "NOT_FOUND" });
        const members = await tx.query.reviewUnits.findMany({
          where: and(
            eq(reviewUnits.snapshotFileId, file.id),
            notInArray(reviewUnits.kind, ["file"]),
          ),
          orderBy: [reviewUnits.reviewOrder],
        });
        if (members.length === 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "This file has no semantic review units to sign off",
          });
        }
        const waits = await tx
          .select({ unitId: reviewWaits.unitId })
          .from(reviewWaits)
          .where(
            and(
              eq(reviewWaits.userId, ctx.auth.userId),
              inArray(
                reviewWaits.unitId,
                members.map(({ id }) => id),
              ),
            ),
          )
          .limit(1);
        if (waits.length > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Resolve the units waiting for a provider response before signing off this file",
          });
        }
        const complexity = members.reduce(
          (total, member) => total + Math.max(1, member.complexity),
          0,
        );
        let allocated = 0;
        const memberInputs = members.map((member, index) => {
          const durationSeconds =
            index === members.length - 1
              ? input.durationSeconds - allocated
              : Math.floor(
                  (input.durationSeconds * Math.max(1, member.complexity)) /
                    complexity,
                );
          allocated += durationSeconds;
          return {
            unitId: member.id,
            sessionId: input.sessionId,
            durationSeconds,
          };
        });
        const outcomes = await persistSignOffs(
          tx,
          ctx.auth.userId,
          memberInputs,
        );
        const writes: PersistedSignOff[] = [];
        for (const { unitId } of memberInputs) {
          const outcome = outcomes.get(unitId);
          if (!outcome) throw new TRPCError({ code: "NOT_FOUND" });
          if (!outcome.ok) throw signOffFailure(outcome);
          writes.push(outcome.write);
        }
        await finalizeSignOffs(tx, ctx.auth.userId, writes);
        return {
          snapshotFileId: file.id,
          signedUnitIds: members.map(({ id }) => id),
        };
      }),
    ),

  unreviewFile: protectedProcedure
    .input(unreviewFileSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const file = await currentSnapshotFileForMember(
          tx,
          ctx.auth.userId,
          input.snapshotFileId,
        );
        if (!file) throw new TRPCError({ code: "NOT_FOUND" });
        const members = await tx
          .select({
            id: reviewUnits.id,
            stableKey: reviewUnits.stableKey,
            complexity: reviewUnits.complexity,
          })
          .from(reviewUnits)
          .where(
            and(
              eq(reviewUnits.snapshotFileId, file.id),
              notInArray(reviewUnits.kind, ["file"]),
            ),
          );
        if (members.length === 0) {
          return { snapshotFileId: file.id, unreviewedUnitIds: [] };
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${file.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        const active = await tx
          .select({
            unitId: signOffs.unitId,
            signedOffAt: signOffs.signedOffAt,
            durationSeconds: signOffs.durationSeconds,
            complexity: reviewUnits.complexity,
          })
          .from(signOffs)
          .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
          .where(
            and(
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              inArray(
                signOffs.unitId,
                members.map(({ id }) => id),
              ),
            ),
          );
        if (active.length === 0) {
          return { snapshotFileId: file.id, unreviewedUnitIds: [] };
        }
        const lineage = await tx
          .select({ id: reviewUnits.id })
          .from(reviewUnits)
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .where(
            and(
              eq(reviewSnapshots.pullRequestId, file.pullRequestId),
              inArray(
                reviewUnits.stableKey,
                members.map(({ stableKey }) => stableKey),
              ),
            ),
          );
        await tx
          .update(signOffs)
          .set({ invalidatedAt: new Date() })
          .where(
            and(
              eq(signOffs.userId, ctx.auth.userId),
              isNull(signOffs.invalidatedAt),
              inArray(
                signOffs.unitId,
                lineage.map(({ id }) => id),
              ),
            ),
          );
        if (input.sessionId) {
          const session = await tx.query.reviewSessions.findFirst({
            where: and(
              eq(reviewSessions.id, input.sessionId),
              eq(reviewSessions.userId, ctx.auth.userId),
              eq(reviewSessions.snapshotId, file.snapshotId),
            ),
          });
          if (session) {
            const inSession = active.filter(
              ({ signedOffAt }) => signedOffAt >= session.startedAt,
            );
            const experience = inSession.reduce(
              (total, signOff) =>
                total +
                reviewExperience(signOff.complexity, signOff.durationSeconds),
              0,
            );
            await tx
              .update(reviewSessions)
              .set({
                reviewedUnits: sql`greatest(${reviewSessions.reviewedUnits} - ${inSession.length}, 0)`,
                experienceAwarded: sql`greatest(${reviewSessions.experienceAwarded} - ${experience}, 0)`,
                completedAt: null,
              })
              .where(eq(reviewSessions.id, session.id));
          }
        }
        await recomputeReviewStats(tx, ctx.auth.userId);
        return {
          snapshotFileId: file.id,
          unreviewedUnitIds: active.map(({ unitId }) => unitId),
        };
      }),
    ),

  signOff: protectedProcedure
    .input(signOffSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const outcome = (
          await persistSignOffs(tx, ctx.auth.userId, [input])
        ).get(input.unitId);
        if (!outcome) throw new TRPCError({ code: "NOT_FOUND" });
        if (!outcome.ok) throw signOffFailure(outcome);
        await finalizeSignOffs(tx, ctx.auth.userId, [outcome.write]);
        return outcome.write.signOff;
      }),
    ),

  signOffBatch: protectedProcedure
    .input(signOffBatchSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const writes: PersistedSignOff[] = [];
        const results = new Map<
          string,
          | { ok: true; unitId: string }
          | {
              code: "CONFLICT" | "NOT_FOUND";
              message: string;
              ok: false;
              unitId: string;
            }
        >();
        const ordered = [...input.signOffs].sort((left, right) =>
          left.unitId.localeCompare(right.unitId),
        );
        const outcomes = await persistSignOffs(tx, ctx.auth.userId, ordered);
        for (const { unitId } of ordered) {
          const outcome = outcomes.get(unitId);
          if (!outcome) continue;
          if (outcome.ok) {
            writes.push(outcome.write);
            results.set(unitId, { ok: true, unitId });
            continue;
          }
          results.set(unitId, {
            code: outcome.code,
            // A rejected unit reports the message its own mutation would raise.
            message: outcome.message ?? outcome.code,
            ok: false,
            unitId,
          });
        }
        await finalizeSignOffs(tx, ctx.auth.userId, writes);
        return input.signOffs.map(
          ({ unitId }) =>
            results.get(unitId) ?? {
              code: "NOT_FOUND" as const,
              message: "The review unit could not be saved",
              ok: false as const,
              unitId,
            },
        );
      }),
    ),

  unreview: protectedProcedure
    .input(unreviewSchema)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [unit] = await tx
          .select({
            id: reviewUnits.id,
            snapshotId: reviewUnits.snapshotId,
            semanticHash: reviewUnits.semanticHash,
            complexity: reviewUnits.complexity,
            stableKey: reviewUnits.stableKey,
            pullRequestId: pullRequests.id,
          })
          .from(reviewUnits)
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .innerJoin(
            pullRequests,
            eq(reviewSnapshots.pullRequestId, pullRequests.id),
          )
          .innerJoin(
            repositories,
            eq(pullRequests.repositoryId, repositories.id),
          )
          .innerJoin(
            workspaceMembers,
            eq(repositories.workspaceId, workspaceMembers.workspaceId),
          )
          .where(
            and(
              eq(reviewUnits.id, input.unitId),
              eq(reviewSnapshots.headSha, pullRequests.headSha),
              eq(reviewSnapshots.baseSha, pullRequests.baseSha),
              eq(workspaceMembers.userId, ctx.auth.userId),
            ),
          )
          .limit(1);
        if (!unit) throw new TRPCError({ code: "NOT_FOUND" });

        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`review-signoffs:${unit.pullRequestId}:${ctx.auth.userId}`}))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${unit.id}:${ctx.auth.userId}`}))`,
        );
        const activeSignOff = await tx.query.signOffs.findFirst({
          where: and(
            eq(signOffs.unitId, unit.id),
            eq(signOffs.userId, ctx.auth.userId),
            eq(signOffs.semanticHash, unit.semanticHash),
            isNull(signOffs.invalidatedAt),
          ),
          orderBy: [desc(signOffs.signedOffAt)],
        });
        if (!activeSignOff) return { unreviewed: false };

        const lineageUnits = await tx
          .select({ id: reviewUnits.id })
          .from(reviewUnits)
          .innerJoin(
            reviewSnapshots,
            eq(reviewUnits.snapshotId, reviewSnapshots.id),
          )
          .where(
            and(
              eq(reviewSnapshots.pullRequestId, unit.pullRequestId),
              eq(reviewUnits.stableKey, unit.stableKey),
            ),
          );
        await tx
          .update(signOffs)
          .set({ invalidatedAt: new Date() })
          .where(
            and(
              inArray(
                signOffs.unitId,
                lineageUnits.map(({ id }) => id),
              ),
              eq(signOffs.userId, ctx.auth.userId),
              eq(signOffs.semanticHash, activeSignOff.semanticHash),
              eq(signOffs.signedOffAt, activeSignOff.signedOffAt),
              isNull(signOffs.invalidatedAt),
            ),
          );

        if (input.sessionId) {
          const session = await tx.query.reviewSessions.findFirst({
            where: and(
              eq(reviewSessions.id, input.sessionId),
              eq(reviewSessions.userId, ctx.auth.userId),
              eq(reviewSessions.snapshotId, unit.snapshotId),
            ),
          });
          if (session && activeSignOff.signedOffAt >= session.startedAt) {
            const experience = reviewExperience(
              unit.complexity,
              activeSignOff.durationSeconds,
            );
            await tx
              .update(reviewSessions)
              .set({
                reviewedUnits: sql`greatest(${reviewSessions.reviewedUnits} - 1, 0)`,
                experienceAwarded: sql`greatest(${reviewSessions.experienceAwarded} - ${experience}, 0)`,
                completedAt: null,
              })
              .where(eq(reviewSessions.id, session.id));
          }
        }

        await recomputeReviewStats(tx, ctx.auth.userId);
        return { unreviewed: true };
      }),
    ),

  gamification: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.auth.userId),
    });
    const reviewEvents = await ctx.db
      .selectDistinct({
        semanticHash: signOffs.semanticHash,
        signedOffAt: signOffs.signedOffAt,
        durationSeconds: signOffs.durationSeconds,
      })
      .from(signOffs)
      .where(
        and(
          eq(signOffs.userId, ctx.auth.userId),
          isNull(signOffs.invalidatedAt),
        ),
      );
    return {
      currentStreak: user?.currentStreak ?? 0,
      longestStreak: user?.longestStreak ?? 0,
      experiencePoints: user?.experiencePoints ?? 0,
      totalSignOffs: reviewEvents.length,
      reviewSeconds: reviewEvents.reduce(
        (total, event) => total + event.durationSeconds,
        0,
      ),
    };
  }),
});

/** Calculates experience awarded for a completed review unit. */
function reviewExperience(complexity: number, durationSeconds: number) {
  return Math.min(
    75,
    5 + complexity * 3 + Math.round(Math.min(durationSeconds, 600) / 30),
  );
}

/** Recalculates review achievements and streaks from persisted activity. */
async function recomputeReviewStats(
  tx: Parameters<Parameters<(typeof database)["transaction"]>[0]>[0],
  userId: string,
) {
  const events = await tx
    .selectDistinct({
      semanticHash: signOffs.semanticHash,
      signedOffAt: signOffs.signedOffAt,
      durationSeconds: signOffs.durationSeconds,
      complexity: reviewUnits.complexity,
    })
    .from(signOffs)
    .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
    .where(and(eq(signOffs.userId, userId), isNull(signOffs.invalidatedAt)));
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const reviewDays = [
    ...new Set(
      events.map(({ signedOffAt }) =>
        Date.UTC(
          signedOffAt.getUTCFullYear(),
          signedOffAt.getUTCMonth(),
          signedOffAt.getUTCDate(),
        ),
      ),
    ),
  ].sort((a, b) => a - b);
  let runningStreak = 0;
  let longestStreak = 0;
  let previousDay: number | undefined;
  for (const day of reviewDays) {
    runningStreak = previousDay === day - 86_400_000 ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousDay = day;
  }
  const latestDay = reviewDays.at(-1);
  const currentStreak =
    latestDay === today || latestDay === today - 86_400_000 ? runningStreak : 0;
  const lastReviewDate = events.reduce<Date | null>(
    (latest, event) =>
      !latest || event.signedOffAt > latest ? event.signedOffAt : latest,
    null,
  );
  const experiencePoints = events.reduce(
    (total, event) =>
      total + reviewExperience(event.complexity, event.durationSeconds),
    0,
  );

  await tx
    .update(users)
    .set({
      experiencePoints,
      currentStreak,
      longestStreak,
      lastReviewDate,
    })
    .where(eq(users.id, userId));
}
