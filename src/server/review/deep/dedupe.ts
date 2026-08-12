import "server-only";

import { createHash } from "node:crypto";
import { generateText } from "ai";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { aiJobs, aiReviewFindings, aiReviewItems } from "@/drizzle/schema";
import { resolveAiModel } from "~/server/ai/models";
import type { TokenUsage } from "~/server/ai/service";
import type { db as database } from "~/server/db";
import { observeOperation } from "~/server/observability/sentry";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import type { AnchorSide } from "./anchor";
import type { FindingCategory, FindingSeverity } from "./findings";
import { sanitizeReason } from "./redaction";
import {
  DEEP_REVIEW_DEDUPE_MAX_GROUP_SIZE,
  DEEP_REVIEW_DEDUPE_SYSTEM_PROMPT,
  type DedupePromptFinding,
  dedupeUserPrompt,
} from "./review-prompts";

type Database = typeof database;

/**
 * The smallest surviving set worth one clustering call.
 *
 * The deterministic pass has already collapsed everything that agrees exactly,
 * so below this size the remaining findings are almost always distinct and the
 * call buys nothing but a suppression channel.
 */
export const DEEP_REVIEW_DEDUPE_MIN = 3;

/**
 * The largest set one clustering call may reason over.
 *
 * The damage a bad partition does grows with the input, and so does the chance
 * the model loses ids in a long list, so an unusually large run keeps its
 * deterministic collapse and skips the model entirely.
 */
const MAX_CLUSTERED_FINDINGS = 200;

const MAX_DEDUPE_OUTPUT_TOKENS = 8_000;
const DEDUPE_TIMEOUT_MS = 120_000;
const MAX_MERGED_TITLE_LENGTH = 200;
const MAX_MERGED_BODY_LENGTH = 4_000;

/** The finding states that are still candidates for a merge. */
const DEDUPE_FINDING_STATES = [
  "anchored",
  "unanchored",
  "out_of_scope",
  "ungrounded",
] as const;

export interface DeepReviewDedupeFinding {
  id: string;
  path: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  body: string;
  startLine: number | null;
  endLine: number | null;
  anchorSide: AnchorSide | null;
}

export interface DeepReviewDedupeGroup {
  canonicalId: string;
  memberIds: string[];
  /** Null keeps the canonical member's own wording. */
  title: string | null;
  body: string | null;
}

export interface DeepReviewDedupeValidationInput {
  groups: readonly DeepReviewDedupeGroup[];
  /** Exactly the findings the grouping was asked to partition. */
  findings: readonly { id: string; path: string | null }[];
  /** Id sets the deterministic pass matched, which the caps do not judge. */
  deterministicGroups?: readonly (readonly string[])[];
  maxGroupSize?: number;
}

export interface DeepReviewDedupeResolution {
  groups: DeepReviewDedupeGroup[];
  /** Why the proposal was rejected; empty when it was accepted or absent. */
  errors: string[];
  rejected: boolean;
  mergedCount: number;
}

export interface DeepReviewDedupeResult extends DeepReviewDedupeResolution {
  candidateCount: number;
  /** Whether the clustering call actually ran. */
  clustered: boolean;
  usage: TokenUsage;
}

export interface RunDeepReviewDedupeInput {
  parentJobId: string;
  /** The child job the clustering call is billed and attributed to. */
  job: typeof aiJobs.$inferSelect;
  minimumFindings?: number;
  maxGroupSize?: number;
}

const dedupeResponseSchema = z.object({
  groups: z.array(
    z.object({
      canonicalId: z.string().min(1),
      memberIds: z.array(z.string().min(1)).min(1),
      title: z.string().optional(),
      body: z.string().optional(),
    }),
  ),
});

const findingContentSchema = z.object({
  title: z.string().default(""),
  body: z.string().default(""),
  existingCode: z.string().optional(),
  suggestionCode: z.string().optional(),
});

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  microUsd: 0,
};

/** Reduces a title to the form two wordings of one defect share. */
export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
}

/**
 * Derives the key that collapses findings without asking a model anything.
 *
 * Two findings share a key only when they agree on the file, the side, the
 * exact resolved lines and the title text, which is the half of the problem
 * that needs no judgement — and the half a model must never be trusted with.
 */
export function deterministicDedupeKey(
  finding: DeepReviewDedupeFinding,
): string {
  return createHash("sha256")
    .update(
      [
        finding.path ?? "",
        finding.anchorSide ?? "",
        finding.startLine ?? "",
        finding.endLine ?? "",
        normalizeFindingTitle(finding.title),
      ].join("\0"),
    )
    .digest("hex");
}

/** Collapses exact agreement into groups, in the caller's stable order. */
export function collapseIdenticalFindings(
  findings: readonly DeepReviewDedupeFinding[],
): DeepReviewDedupeGroup[] {
  const groups = new Map<string, DeepReviewDedupeGroup>();
  for (const finding of findings) {
    const key = deterministicDedupeKey(finding);
    const group = groups.get(key);
    if (group) {
      group.memberIds.push(finding.id);
      continue;
    }
    groups.set(key, {
      canonicalId: finding.id,
      memberIds: [finding.id],
      // A collapse of identical findings has no merged wording to write: the
      // canonical member already says exactly what its duplicates said.
      title: null,
      body: null,
    });
  }
  return [...groups.values()];
}

/** Keys an id set so a proposed group can be compared with a matched one. */
function groupSignature(memberIds: readonly string[]): string {
  return [...memberIds].sort().join("\0");
}

/**
 * Reports every assertion that makes a whole proposed grouping unusable.
 *
 * The partition rules are OCR's all-or-nothing discipline
 * (`internal/scan/agent.go:986-999`). The two caps are ours: a response putting
 * every id in one group is a perfectly valid partition, and accepting it would
 * suppress the entire review behind a single merged finding.
 */
export function deepReviewDedupeErrors(
  input: DeepReviewDedupeValidationInput,
): string[] {
  const errors: string[] = [];
  const maxGroupSize = input.maxGroupSize ?? DEEP_REVIEW_DEDUPE_MAX_GROUP_SIZE;
  const paths = new Map(
    input.findings.map((finding) => [finding.id, finding.path]),
  );
  const matched = new Set(
    (input.deterministicGroups ?? []).map((ids) => groupSignature(ids)),
  );
  const seen = new Set<string>();

  for (const [index, group] of input.groups.entries()) {
    const label = describeGroup(group, index);
    if (!group.memberIds.includes(group.canonicalId)) {
      errors.push(
        `${label} names canonical id ${sanitizeReason(group.canonicalId, { maxLength: 80 })} that is not one of its members`,
      );
    }
    for (const id of group.memberIds) {
      const readable = sanitizeReason(id, { maxLength: 80 });
      if (!paths.has(id)) {
        errors.push(`${label} names unknown finding id ${readable}`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`finding id ${readable} appears in more than one group`);
        continue;
      }
      seen.add(id);
    }
    // A group the deterministic pass produced was matched on exact equality,
    // not on judgement, so neither cap is evidence of anything about it.
    if (matched.has(groupSignature(group.memberIds))) continue;
    if (group.memberIds.length > maxGroupSize) {
      errors.push(
        `${label} merges ${group.memberIds.length} findings, more than the maximum of ${maxGroupSize}`,
      );
    }
    const groupPaths = new Set(
      group.memberIds.filter((id) => paths.has(id)).map((id) => paths.get(id)),
    );
    if (groupPaths.size > 1) {
      errors.push(`${label} merges findings across ${groupPaths.size} paths`);
    }
  }

  for (const finding of input.findings) {
    if (!seen.has(finding.id)) {
      errors.push(
        `finding id ${sanitizeReason(finding.id, { maxLength: 80 })} is missing from the grouping`,
      );
    }
  }
  return errors;
}

/** Names a group for an assertion message, by its canonical id when it has one. */
function describeGroup(group: DeepReviewDedupeGroup, index: number): string {
  const canonical = group.canonicalId
    ? sanitizeReason(group.canonicalId, { maxLength: 80 })
    : `#${index}`;
  return `group ${canonical}`;
}

/** Trims merged wording to the same ceilings a reported finding lives under. */
function mergedText(value: string | undefined, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maximum);
}

/**
 * Settles the final grouping, falling back to the deterministic one entirely.
 *
 * Rejection is all or nothing: a proposal that loses one id says nothing
 * trustworthy about the ids it kept, so the deterministic collapse — which no
 * model touched — is what survives.
 */
export function resolveDeepReviewDedupe(input: {
  findings: readonly DeepReviewDedupeFinding[];
  deterministic: readonly DeepReviewDedupeGroup[];
  proposed?: readonly DeepReviewDedupeGroup[] | null;
  maxGroupSize?: number;
}): DeepReviewDedupeResolution {
  const deterministic = input.deterministic.map((group) => ({
    ...group,
    memberIds: [...group.memberIds],
  }));
  if (!input.proposed) {
    return {
      groups: deterministic,
      errors: [],
      rejected: false,
      mergedCount: countMerged(deterministic),
    };
  }
  // The proposal partitions the representatives, one per deterministic group,
  // because those are the findings the model was shown.
  const byCanonical = new Map(
    deterministic.map((group) => [group.canonicalId, group]),
  );
  const representatives = deterministic.map((group) => {
    const finding = input.findings.find(
      (candidate) => candidate.id === group.canonicalId,
    );
    return { id: group.canonicalId, path: finding?.path ?? null };
  });
  const errors = deepReviewDedupeErrors({
    groups: input.proposed,
    findings: representatives,
    deterministicGroups: deterministic.map((group) => group.memberIds),
    maxGroupSize: input.maxGroupSize,
  });
  if (errors.length > 0) {
    return {
      groups: deterministic,
      errors,
      rejected: true,
      mergedCount: countMerged(deterministic),
    };
  }
  const groups = input.proposed.map((group) => ({
    canonicalId: group.canonicalId,
    // Expanding representatives back into their duplicates is what keeps the
    // merge total: a member the deterministic pass collapsed must follow the
    // representative it was collapsed into.
    memberIds: group.memberIds.flatMap(
      (id) => byCanonical.get(id)?.memberIds ?? [id],
    ),
    title: group.title,
    body: group.body,
  }));
  return {
    groups,
    errors: [],
    rejected: false,
    mergedCount: countMerged(groups),
  };
}

/** Counts the findings a grouping removes from the surfaced list. */
function countMerged(groups: readonly DeepReviewDedupeGroup[]): number {
  return groups.reduce((total, group) => total + group.memberIds.length - 1, 0);
}

/** Extracts the JSON object from a response that may still carry a fence. */
export function parseDedupeResponse(
  text: string,
): DeepReviewDedupeGroup[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const response = dedupeResponseSchema.safeParse(parsed);
  if (!response.success) return null;
  return response.data.groups.map((group) => ({
    canonicalId: group.canonicalId,
    memberIds: [...group.memberIds],
    title: mergedText(group.title, MAX_MERGED_TITLE_LENGTH),
    body: mergedText(group.body, MAX_MERGED_BODY_LENGTH),
  }));
}

/** Renders one candidate into the shape the clustering prompt expects. */
function promptFinding(finding: DeepReviewDedupeFinding): DedupePromptFinding {
  return {
    id: finding.id,
    path: finding.path,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    startLine: finding.startLine,
    endLine: finding.endLine,
    anchorSide: finding.anchorSide,
  };
}

/** Normalizes provider usage into the ledger representation a run rolls up. */
function usageFromResult(result: {
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
  providerMetadata?: unknown;
}): TokenUsage {
  const metadata = result.providerMetadata as
    | { openrouter?: { usage?: { cost?: number } } }
    | undefined;
  return {
    input: result.usage.inputTokens ?? 0,
    output: result.usage.outputTokens ?? 0,
    cacheRead: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWrite: result.usage.inputTokenDetails.cacheWriteTokens ?? 0,
    totalTokens: result.usage.totalTokens ?? 0,
    microUsd: Math.ceil((metadata?.openrouter?.usage?.cost ?? 0) * 1_000_000),
  };
}

/** Adds the clustering call's usage to the child that is billed for it. */
async function accumulateUsage(
  db: Database,
  jobId: string,
  usage: TokenUsage,
): Promise<void> {
  await db
    .update(aiJobs)
    .set({
      inputTokens: sql`${aiJobs.inputTokens} + ${usage.input}`,
      outputTokens: sql`${aiJobs.outputTokens} + ${usage.output}`,
      cacheReadTokens: sql`${aiJobs.cacheReadTokens} + ${usage.cacheRead}`,
      cacheWriteTokens: sql`${aiJobs.cacheWriteTokens} + ${usage.cacheWrite}`,
      totalTokens: sql`${aiJobs.totalTokens} + ${usage.totalTokens}`,
      actualMicroUsd: sql`${aiJobs.actualMicroUsd} + ${usage.microUsd ?? 0}`,
    })
    .where(eq(aiJobs.id, jobId));
}

/** Asks the model for one grouping, treating every failure as no proposal. */
export async function clusterDeepReviewFindings(
  db: Database,
  input: {
    job: typeof aiJobs.$inferSelect;
    findings: readonly DeepReviewDedupeFinding[];
  },
): Promise<{
  groups: DeepReviewDedupeGroup[] | null;
  usage: TokenUsage;
  error: string | null;
}> {
  try {
    const resolved = await resolveAiModel(db, {
      workspaceId: input.job.workspaceId,
      provider: input.job.provider ?? "",
      model: input.job.model ?? "",
    });
    const result = await observeOperation(
      "ai.deep-review-dedupe",
      "ai.model",
      () =>
        generateText({
          model: resolved.model,
          system: DEEP_REVIEW_DEDUPE_SYSTEM_PROMPT,
          prompt: dedupeUserPrompt({
            findings: input.findings.map(promptFinding),
          }),
          maxRetries: 0,
          maxOutputTokens: MAX_DEDUPE_OUTPUT_TOKENS,
          timeout: DEDUPE_TIMEOUT_MS,
          // These options carry zero data retention and the refusal to fall
          // back to another provider, so no model call may omit them.
          providerOptions: resolved.providerOptions,
          telemetry: { isEnabled: false },
        }),
    );
    const usage = usageFromResult(result);
    const groups = parseDedupeResponse(result.text);
    return {
      groups,
      usage,
      error: groups ? null : "the clustering response was not a JSON grouping",
    };
  } catch (cause) {
    return {
      groups: null,
      usage: EMPTY_USAGE,
      error: sanitizeReason(
        cause instanceof Error ? cause.message : "the clustering call failed",
      ),
    };
  }
}

/** Loads the run's surviving findings with their sealed wording opened. */
async function loadDedupeCandidates(
  db: Database,
  parentJobId: string,
): Promise<DeepReviewDedupeFinding[]> {
  const items = await db.query.aiReviewItems.findMany({
    columns: { id: true },
    where: eq(aiReviewItems.parentJobId, parentJobId),
  });
  if (items.length === 0) return [];
  const rows = await db
    .select({
      id: aiReviewFindings.id,
      workspaceId: aiReviewFindings.workspaceId,
      path: aiReviewFindings.path,
      severity: aiReviewFindings.severity,
      category: aiReviewFindings.category,
      startLine: aiReviewFindings.startLine,
      endLine: aiReviewFindings.endLine,
      anchorSide: aiReviewFindings.anchorSide,
      encryptedContent: aiReviewFindings.encryptedContent,
    })
    .from(aiReviewFindings)
    .where(
      and(
        inArray(
          aiReviewFindings.itemId,
          items.map((item) => item.id),
        ),
        inArray(aiReviewFindings.state, [...DEDUPE_FINDING_STATES]),
        isNull(aiReviewFindings.mergedIntoId),
      ),
    );
  const candidates = await Promise.all(
    rows.map(async (row) => {
      const content = await readFindingContent(row);
      // A finding whose wording cannot be opened cannot be compared with
      // anything, and dropping it from the input would break the partition, so
      // it simply keeps its own group.
      if (!content) return undefined;
      return {
        id: row.id,
        path: row.path,
        severity: row.severity,
        category: row.category,
        title: content.title,
        body: content.body,
        startLine: row.startLine,
        endLine: row.endLine,
        anchorSide: row.anchorSide,
      } satisfies DeepReviewDedupeFinding;
    }),
  );
  // Replay stability: the canonical member of a deterministic group is its
  // first member, so the order the candidates arrive in must not depend on the
  // planner's row order.
  return candidates
    .filter((candidate) => candidate !== undefined)
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** Opens one finding's sealed content, returning nothing when it cannot. */
async function readFindingContent(row: {
  id: string;
  workspaceId: string;
  encryptedContent: string;
}): Promise<z.infer<typeof findingContentSchema> | undefined> {
  try {
    return findingContentSchema.parse(
      JSON.parse(
        await openVaultSecret(
          {
            workspaceId: row.workspaceId,
            recordId: row.id,
            provider: "ai-review-finding",
          },
          row.encryptedContent,
        ),
      ),
    );
  } catch {
    return undefined;
  }
}

/** Writes one settled grouping: members merge away, the canonical may reword. */
async function persistDedupeGroups(
  db: Database,
  input: {
    groups: readonly DeepReviewDedupeGroup[];
    findings: readonly DeepReviewDedupeFinding[];
    workspaceId: string;
  },
): Promise<void> {
  if (input.findings.length === 0) return;
  const rows = await db
    .select({
      id: aiReviewFindings.id,
      encryptedContent: aiReviewFindings.encryptedContent,
    })
    .from(aiReviewFindings)
    .where(
      inArray(
        aiReviewFindings.id,
        input.findings.map((finding) => finding.id),
      ),
    );
  const sealed = new Map(rows.map((row) => [row.id, row.encryptedContent]));
  for (const group of input.groups) {
    const members = group.memberIds.filter((id) => id !== group.canonicalId);
    if (members.length > 0) {
      await db
        .update(aiReviewFindings)
        .set({ state: "merged", mergedIntoId: group.canonicalId })
        .where(inArray(aiReviewFindings.id, members));
    }
    if (members.length === 0 || (!group.title && !group.body)) continue;
    const encryptedContent = sealed.get(group.canonicalId);
    if (!encryptedContent) continue;
    const content = await readFindingContent({
      id: group.canonicalId,
      workspaceId: input.workspaceId,
      encryptedContent,
    });
    if (!content) continue;
    await db
      .update(aiReviewFindings)
      .set({
        // Only the wording moves. The anchor, severity, side, unit and
        // evidence stay exactly as the canonical finding reported them, so a
        // merge can never relocate a comment or invent a location.
        encryptedContent: await sealVaultSecret(
          {
            workspaceId: input.workspaceId,
            recordId: group.canonicalId,
            provider: "ai-review-finding",
          },
          JSON.stringify({
            ...content,
            title: group.title ?? content.title,
            body: group.body ?? content.body,
          }),
        ),
      })
      .where(eq(aiReviewFindings.id, group.canonicalId));
  }
}

/**
 * Collapses one run's duplicate findings, deterministically first.
 *
 * Safe to call twice: merged findings leave the candidate set, so a replayed
 * step reasons only over what survived the first pass and converges.
 */
export async function runDeepReviewDedupe(
  db: Database,
  input: RunDeepReviewDedupeInput,
): Promise<DeepReviewDedupeResult> {
  const findings = await loadDedupeCandidates(db, input.parentJobId);
  const deterministic = collapseIdenticalFindings(findings);
  const minimum = input.minimumFindings ?? DEEP_REVIEW_DEDUPE_MIN;
  const clusterable =
    deterministic.length > minimum &&
    deterministic.length <= MAX_CLUSTERED_FINDINGS;
  const representatives = deterministic.flatMap((group) => {
    const finding = findings.find(
      (candidate) => candidate.id === group.canonicalId,
    );
    return finding ? [finding] : [];
  });
  const clustered = clusterable
    ? await clusterDeepReviewFindings(db, {
        job: input.job,
        findings: representatives,
      })
    : { groups: null, usage: EMPTY_USAGE, error: null };
  if (clustered.usage.totalTokens > 0 || clustered.usage.input > 0) {
    await accumulateUsage(db, input.job.id, clustered.usage);
  }
  const resolution = resolveDeepReviewDedupe({
    findings,
    deterministic,
    proposed: clustered.groups,
    maxGroupSize: input.maxGroupSize,
  });
  await persistDedupeGroups(db, {
    groups: resolution.groups,
    findings,
    workspaceId: input.job.workspaceId,
  });
  return {
    ...resolution,
    errors: clustered.error
      ? [clustered.error, ...resolution.errors]
      : resolution.errors,
    candidateCount: findings.length,
    clustered: clusterable,
    usage: clustered.usage,
  };
}
