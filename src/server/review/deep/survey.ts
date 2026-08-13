import "server-only";

import { createHash } from "node:crypto";
import { tool } from "@ai-sdk/provider-utils";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  aiJobEvidence,
  type aiJobs,
  aiJobToolCalls,
  aiReviewFindingLocations,
  aiReviewFindings,
  aiReviewItems,
  pullRequests,
  reviewUnitDependencies,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";
import {
  type AnchorRange,
  type AnchorSide,
  type AnchorTier,
  anchorIsGrounded,
  resolveAnchor,
} from "./anchor";
import type { DeepReviewContext } from "./context";
import {
  type DeepReviewToolExecutor,
  type DeepReviewToolLimits,
  deepReviewFileTools,
} from "./file-tools";
import {
  deepReviewFindingId,
  type FindingSeverity,
  normalizeFindingCategory,
  normalizeFindingSeverity,
} from "./findings";
import type {
  SurveyPromptDependencyEdge,
  SurveyPromptFileFinding,
  SurveyPromptInput,
} from "./review-prompts";

type Database = typeof database;

/**
 * The coverage item the survey child reports against.
 *
 * `ai_review_finding.itemId` is not nullable, so a cross-file finding still
 * needs an item to hang from. The path is a sentinel rather than a file so the
 * unique index on (parentJobId, path) cannot collide with a real one.
 */
export const DEEP_REVIEW_SURVEY_ITEM_PATH = "(cross-file survey)";

const SURVEY_ITEM_CHANGE_TYPE = "survey";
const MAX_SURVEY_FINDINGS = 15;
const MAX_SURVEY_FINDINGS_PER_CALL = 5;
const MAX_SURVEY_LOCATIONS = 6;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 4_000;
const MAX_SNIPPET_LENGTH = 4_000;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_ANCHOR_SOURCE_BYTES = 1_000_000;
const MAX_PROMPT_FILES = 200;
const MAX_PROMPT_UNITS = 300;
const MAX_PROMPT_DEPENDENCIES = 300;
const MAX_PROMPT_FILE_FINDINGS = 100;

/** Severities worst-first, so the next index is exactly one level milder. */
const SEVERITY_LADDER: readonly FindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

export const deepReviewReportSurveyFindingSchema = z.object({
  findings: z
    .array(
      z.object({
        title: z.string().min(1).max(MAX_TITLE_LENGTH),
        body: z.string().min(1).max(MAX_BODY_LENGTH),
        // Free strings, normalized after the fact, so an unknown value degrades
        // one finding instead of failing the whole call.
        severity: z.string().max(32),
        category: z.string().max(32),
        locations: z
          .array(
            z.object({
              path: z.string().min(1).max(2_000),
              existing_code: z.string().min(1).max(MAX_SNIPPET_LENGTH),
            }),
          )
          // A cross-file finding that names one file is a file finding, and the
          // file agents have already reviewed every file on its own.
          .min(2)
          .max(MAX_SURVEY_LOCATIONS),
      }),
    )
    .min(1)
    .max(MAX_SURVEY_FINDINGS_PER_CALL),
});

export interface DeepReviewSurveyToolContext {
  db: Database;
  /** The single whole-pull-request child job. */
  job: typeof aiJobs.$inferSelect;
  /** The survey's own coverage item, from `ensureDeepReviewSurveyItem`. */
  itemId: string;
  repository: DeepReviewContext;
  execute: DeepReviewToolExecutor;
  limits?: DeepReviewToolLimits;
  sourceBytesRead?: number;
  readPaths?: Iterable<string>;
  reportedFindings?: number;
  onFinishSurvey?: (input: { summary: string }) => void;
}

export interface SurveyLocationAnchor {
  path: string;
  tier: AnchorTier;
  side: AnchorSide | null;
  startLine: number | null;
  endLine: number | null;
  /** Whether the pull request changes the file this location names. */
  changed: boolean;
  /** Whether the survey agent provably read the bytes it landed on. */
  grounded: boolean;
}

export interface SurveyFindingResolution {
  state: "anchored" | "unanchored" | "out_of_scope";
  severity: FindingSeverity;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  anchorTier: AnchorTier | null;
  anchorSide: AnchorSide | null;
  anchorAmbiguous: boolean;
  /** Whether the ungrounded exemption cost the finding a severity level. */
  downgraded: boolean;
}

/** Lowers a severity by exactly one level, never below the mildest. */
export function downgradeFindingSeverity(
  severity: FindingSeverity,
): FindingSeverity {
  const index = SEVERITY_LADDER.indexOf(severity);
  if (index < 0) return "low";
  return (
    SEVERITY_LADDER[Math.min(index + 1, SEVERITY_LADDER.length - 1)] ?? "low"
  );
}

/**
 * Settles one cross-file finding from the locations it named.
 *
 * The evidence gate is deliberately not applied: a survey finding has no
 * per-file byte range by construction, so failing it closed would delete the
 * one recall class the file agents cannot produce. An ungrounded finding is
 * kept and demoted one severity level instead, which prices the uncertainty
 * without discarding the finding.
 */
export function surveyFindingResolution(input: {
  severity: FindingSeverity;
  locations: readonly SurveyLocationAnchor[];
}): SurveyFindingResolution {
  const resolved = input.locations.find(
    (location) => location.startLine !== null,
  );
  const ambiguous = input.locations.some(
    (location) => location.tier === "ambiguous",
  );
  // Scope is judged over the whole finding, not per location: a removed export
  // with a surviving importer is precisely a finding whose second location
  // lives in code this pull request never touched.
  const inScope = input.locations.some((location) => location.changed);
  const grounded = input.locations.some((location) => location.grounded);
  const downgraded = Boolean(resolved) && !grounded;
  const severity = downgraded
    ? downgradeFindingSeverity(input.severity)
    : input.severity;
  const state = !resolved
    ? "unanchored"
    : inScope
      ? "anchored"
      : "out_of_scope";
  return {
    state,
    severity,
    path: resolved?.path ?? null,
    startLine: resolved?.startLine ?? null,
    endLine: resolved?.endLine ?? null,
    anchorTier: resolved?.tier ?? (ambiguous ? "ambiguous" : "none"),
    anchorSide: resolved?.side ?? null,
    anchorAmbiguous: ambiguous,
    downgraded,
  };
}

/** Derives a stable location row id so a replayed insert cannot duplicate one. */
export function surveyLocationId(findingId: string, index: number): string {
  const digest = createHash("sha256")
    .update(`${findingId}\0${index}`)
    .digest("hex");
  const variant = (
    (Number.parseInt(digest[16] ?? "8", 16) & 0x3) |
    0x8
  ).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/** Fingerprints the survey item, which is never a reuse candidate. */
function surveyItemFingerprint(parentJobId: string): string {
  return createHash("sha256")
    .update(`${parentJobId}\0${DEEP_REVIEW_SURVEY_ITEM_PATH}`)
    .digest("hex");
}

/**
 * Creates the survey's coverage item, once per run.
 *
 * The item joins the run's denominator, so the survey is covered by the same
 * partition assertion every file is: a survey that never ran leaves a
 * `selected` item for finalize to sweep rather than vanishing silently.
 */
export async function ensureDeepReviewSurveyItem(
  db: Database,
  input: {
    parentJobId: string;
    workspaceId: string;
    childJobId: string | null;
  },
): Promise<string> {
  await db
    .insert(aiReviewItems)
    .values({
      parentJobId: input.parentJobId,
      workspaceId: input.workspaceId,
      childJobId: input.childJobId,
      path: DEEP_REVIEW_SURVEY_ITEM_PATH,
      changeType: SURVEY_ITEM_CHANGE_TYPE,
      changedLineCount: 0,
      state: "selected",
      fingerprint: surveyItemFingerprint(input.parentJobId),
    })
    .onConflictDoNothing({
      target: [aiReviewItems.parentJobId, aiReviewItems.path],
    });
  const item = await db.query.aiReviewItems.findFirst({
    columns: { id: true },
    where: and(
      eq(aiReviewItems.parentJobId, input.parentJobId),
      eq(aiReviewItems.path, DEEP_REVIEW_SURVEY_ITEM_PATH),
    ),
  });
  if (!item) throw new Error("Deep review survey item could not be sealed");
  return item.id;
}

/**
 * Builds the survey agent's tool set: the file agent's readers, plus reporting.
 *
 * The readers are shared verbatim so the survey reads through the same source
 * policy, byte ceilings and evidence recording the file agents do. `read_diff`
 * therefore needs an explicit path here, because the survey's own item names no
 * file of its own.
 */
export function deepReviewSurveyTools(context: DeepReviewSurveyToolContext) {
  const { db, job, itemId, repository } = context;
  const maxFindings = context.limits?.maxFindings ?? MAX_SURVEY_FINDINGS;
  let reportedFindings = context.reportedFindings ?? 0;
  let finished = false;

  const { list_files, search_code, read_file, read_diff } = deepReviewFileTools(
    {
      db,
      job,
      item: { id: itemId, path: DEEP_REVIEW_SURVEY_ITEM_PATH },
      repository,
      execute: context.execute,
      limits: context.limits,
      sourceBytesRead: context.sourceBytesRead,
      readPaths: context.readPaths,
    },
  );

  return {
    list_files,
    search_code,
    read_file,
    read_diff,
    report_survey_finding: tool({
      description:
        "Report one or more defects that span two or more files. Quote the exact existing code at each location; never report a line number.",
      inputSchema: deepReviewReportSurveyFindingSchema,
      execute: (input, options) =>
        context.execute({
          name: "report_survey_finding",
          callId: options.toolCallId,
          arguments: input,
          execute: async () => {
            // Rows are written inside the tool body because a replayed durable
            // step returns the stored output without running this handler, so
            // anything buffered for a post-turn flush would be lost on replay.
            const room = Math.max(0, maxFindings - reportedFindings);
            const accepted = input.findings
              .filter(
                (finding) =>
                  new Set(finding.locations.map((location) => location.path))
                    .size >= 2,
              )
              .slice(0, room);
            const findingIds: string[] = [];
            for (const [index, finding] of accepted.entries()) {
              const id = deepReviewFindingId({
                toolCallId: options.toolCallId,
                index,
              });
              await db
                .insert(aiReviewFindings)
                .values({
                  id,
                  itemId,
                  jobId: job.id,
                  workspaceId: job.workspaceId,
                  // A cross-file finding names no single file until its
                  // locations anchor, so the column stays null on purpose.
                  path: null,
                  severity: normalizeFindingSeverity(finding.severity),
                  category: normalizeFindingCategory(finding.category),
                  encryptedContent: await sealVaultSecret(
                    {
                      workspaceId: job.workspaceId,
                      recordId: id,
                      provider: "ai-review-finding",
                    },
                    JSON.stringify({
                      title: finding.title,
                      body: finding.body,
                    }),
                  ),
                })
                .onConflictDoNothing();
              for (const [
                locationIndex,
                location,
              ] of finding.locations.entries()) {
                const locationId = surveyLocationId(id, locationIndex);
                await db
                  .insert(aiReviewFindingLocations)
                  .values({
                    id: locationId,
                    findingId: id,
                    position: locationIndex,
                    path: location.path,
                    encryptedExistingCode: await sealVaultSecret(
                      {
                        workspaceId: job.workspaceId,
                        recordId: locationId,
                        provider: "ai-review-finding-location",
                      },
                      location.existing_code,
                    ),
                  })
                  .onConflictDoNothing();
              }
              findingIds.push(id);
            }
            reportedFindings += findingIds.length;
            return {
              accepted: findingIds.length,
              declined: input.findings.length - findingIds.length,
              findingIds,
            };
          },
        }),
    }),
    finish_survey: tool({
      description:
        "Declare the cross-file review complete. Call it once, after every finding has been reported.",
      inputSchema: z.object({
        summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
      }),
      execute: (input, options) =>
        context.execute({
          name: "finish_survey",
          callId: options.toolCallId,
          arguments: input,
          execute: async () => {
            if (finished) {
              return {
                accepted: false,
                error: "The survey was already finished",
              };
            }
            finished = true;
            context.onFinishSurvey?.({ summary: input.summary });
            return { accepted: true };
          },
        }),
    }),
  };
}

/**
 * Reports whether the survey agent already declared itself finished.
 *
 * The in-process callback does not fire for a replayed step, so a resumed turn
 * has to consult the durable tool-call row instead.
 */
export async function deepReviewSurveyFinished(
  db: Database,
  jobId: string,
): Promise<boolean> {
  const call = await db.query.aiJobToolCalls.findFirst({
    where: and(
      eq(aiJobToolCalls.jobId, jobId),
      eq(aiJobToolCalls.toolName, "finish_survey"),
      eq(aiJobToolCalls.status, "completed"),
    ),
  });
  return Boolean(call);
}

/** Groups the byte ranges this job read by the exact blob they were read from. */
async function evidenceRangesByBlob(
  db: Database,
  jobId: string,
): Promise<Map<string, AnchorRange[]>> {
  const rows = await db
    .select({
      sourceBlobId: aiJobEvidence.sourceBlobId,
      startLine: aiJobEvidence.startLine,
      endLine: aiJobEvidence.endLine,
    })
    .from(aiJobEvidence)
    .where(eq(aiJobEvidence.jobId, jobId));
  const ranges = new Map<string, AnchorRange[]>();
  for (const row of rows) {
    // Partitioning by blob is what stops a current-revision read grounding a
    // previous-revision anchor: the evidence table carries no side of its own.
    const existing = ranges.get(row.sourceBlobId) ?? [];
    existing.push({ startLine: row.startLine, endLine: row.endLine });
    ranges.set(row.sourceBlobId, existing);
  }
  return ranges;
}

/** Opens one location's sealed snippet, returning nothing when it cannot. */
async function readLocationSnippet(
  workspaceId: string,
  row: { id: string; encryptedExistingCode: string },
): Promise<string | undefined> {
  try {
    return await openVaultSecret(
      {
        workspaceId,
        recordId: row.id,
        provider: "ai-review-finding-location",
      },
      row.encryptedExistingCode,
    );
  } catch {
    return undefined;
  }
}

/**
 * Anchors every location of every survey finding and settles the findings.
 *
 * Each location resolves independently against its own file, and the finding
 * surfaces on the first that resolves, so one unquotable location cannot cost
 * a cross-file finding its position.
 */
export async function validateDeepReviewSurveyFindings(
  db: Database,
  input: {
    job: typeof aiJobs.$inferSelect;
    itemId: string;
    repository: DeepReviewContext;
  },
): Promise<{
  anchored: number;
  unanchored: number;
  outOfScope: number;
  downgraded: number;
}> {
  const findings = await db
    .select({
      id: aiReviewFindings.id,
      severity: aiReviewFindings.severity,
    })
    .from(aiReviewFindings)
    .where(
      and(
        eq(aiReviewFindings.itemId, input.itemId),
        eq(aiReviewFindings.state, "submitted"),
      ),
    );
  const tally = { anchored: 0, unanchored: 0, outOfScope: 0, downgraded: 0 };
  if (findings.length === 0) return tally;

  const locations = await db
    .select({
      id: aiReviewFindingLocations.id,
      findingId: aiReviewFindingLocations.findingId,
      path: aiReviewFindingLocations.path,
      encryptedExistingCode: aiReviewFindingLocations.encryptedExistingCode,
    })
    .from(aiReviewFindingLocations)
    .where(
      inArray(
        aiReviewFindingLocations.findingId,
        findings.map((finding) => finding.id),
      ),
    )
    // The finding surfaces on the first location that resolves, so the read
    // has to hand them back in the order the model named them.
    .orderBy(aiReviewFindingLocations.position);
  const evidence = await evidenceRangesByBlob(db, input.job.id);
  const units = await input.repository.units();
  const byFinding = new Map<string, SurveyLocationAnchor[]>();

  for (const location of locations) {
    const snippet = await readLocationSnippet(input.job.workspaceId, location);
    const file = await input.repository.readFile(
      location.path,
      MAX_ANCHOR_SOURCE_BYTES,
    );
    const previousSource = await input.repository.readPreviousSource(
      location.path,
    );
    const changed = input.repository.changedFile(location.path);
    const anchor = snippet
      ? resolveAnchor({
          existingCode: snippet,
          currentSource: file?.source ?? null,
          previousSource: previousSource ?? null,
          // The survey names files it did not necessarily change, so there are
          // no changed ranges to narrow with; the unit manifest is what keeps
          // the resolver from matching a one-line snippet anywhere at all.
          changedRanges: [],
          unitRanges: units
            .filter((unit) => unit.path === location.path)
            .map((unit) => ({
              startLine: unit.startLine,
              endLine: unit.endLine,
            })),
        })
      : { tier: "none" as const, side: null, startLine: null, endLine: null };
    const blobId =
      anchor.side === "previous"
        ? (changed?.previousBlob?.id ?? null)
        : (file?.blob.id ?? null);
    const grounded =
      blobId !== null &&
      anchorIsGrounded(
        { ...anchor, ambiguous: false },
        evidence.get(blobId) ?? [],
      );
    await db
      .update(aiReviewFindingLocations)
      .set({
        anchorTier: anchor.tier === "none" ? null : anchor.tier,
        anchorSide: anchor.side,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
      })
      .where(eq(aiReviewFindingLocations.id, location.id));
    byFinding.set(location.findingId, [
      ...(byFinding.get(location.findingId) ?? []),
      {
        path: location.path,
        tier: anchor.tier,
        side: anchor.side,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        changed: changed !== undefined,
        grounded,
      },
    ]);
  }

  for (const finding of findings) {
    const resolution = surveyFindingResolution({
      severity: finding.severity,
      locations: byFinding.get(finding.id) ?? [],
    });
    await db
      .update(aiReviewFindings)
      .set({
        state: resolution.state,
        severity: resolution.severity,
        path: resolution.path,
        startLine: resolution.startLine,
        endLine: resolution.endLine,
        anchorTier: resolution.anchorTier,
        anchorSide: resolution.anchorSide,
        anchorAmbiguous: resolution.anchorAmbiguous,
      })
      .where(eq(aiReviewFindings.id, finding.id));
    if (resolution.state === "anchored") tally.anchored += 1;
    if (resolution.state === "unanchored") tally.unanchored += 1;
    if (resolution.state === "out_of_scope") tally.outOfScope += 1;
    if (resolution.downgraded) tally.downgraded += 1;
  }
  return tally;
}

/**
 * Assembles the survey's user message input from the run's own data.
 *
 * The survey is given the shape of the pull request and no file bodies, so it
 * pulls what it needs through the tools rather than being handed a prompt that
 * grows with the change.
 */
export async function deepReviewSurveyPromptInput(
  db: Database,
  input: {
    job: typeof aiJobs.$inferSelect;
    parentJobId: string;
    repository: DeepReviewContext;
  },
): Promise<SurveyPromptInput> {
  const pullRequest = await db.query.pullRequests.findFirst({
    where: eq(pullRequests.id, input.job.pullRequestId),
  });
  if (!pullRequest) throw new Error("Deep review pull request not found");
  const units = await input.repository.units();
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const edges =
    units.length > 0
      ? await db
          .select({
            unitId: reviewUnitDependencies.unitId,
            dependencyId: reviewUnitDependencies.dependencyId,
          })
          .from(reviewUnitDependencies)
          .where(
            inArray(
              reviewUnitDependencies.unitId,
              units.map((unit) => unit.id),
            ),
          )
      : [];
  const dependencies: SurveyPromptDependencyEdge[] = [];
  for (const edge of edges) {
    const from = unitById.get(edge.unitId);
    const to = unitById.get(edge.dependencyId);
    // An edge into a unit outside this snapshot names nothing the survey can
    // read, so it is context the prompt is better off without.
    if (!from || !to || dependencies.length >= MAX_PROMPT_DEPENDENCIES)
      continue;
    dependencies.push({
      fromPath: from.path,
      fromName: from.name,
      toPath: to.path,
      toName: to.name,
      kind: to.kind,
    });
  }
  return {
    pullRequest: {
      title: pullRequest.title,
      description: pullRequest.description,
      sourceBranch: pullRequest.sourceBranch,
      targetBranch: pullRequest.targetBranch,
    },
    files: input.repository
      .changedFiles()
      .slice(0, MAX_PROMPT_FILES)
      .map((file) => ({
        path: file.path,
        changeType: file.changeType,
        changedLineCount: file.additions + file.deletions,
      })),
    units: units.slice(0, MAX_PROMPT_UNITS).map((unit) => ({
      path: unit.path,
      name: unit.name,
      kind: unit.kind,
    })),
    dependencies,
    fileFindings: await surveyFileFindings(db, input),
  };
}

/** Lists what the file agents already reported, so the survey can skip it. */
async function surveyFileFindings(
  db: Database,
  input: { job: typeof aiJobs.$inferSelect; parentJobId: string },
): Promise<SurveyPromptFileFinding[]> {
  const items = await db.query.aiReviewItems.findMany({
    columns: { id: true },
    where: eq(aiReviewItems.parentJobId, input.parentJobId),
  });
  if (items.length === 0) return [];
  const rows = await db
    .select({
      id: aiReviewFindings.id,
      path: aiReviewFindings.path,
      severity: aiReviewFindings.severity,
      encryptedContent: aiReviewFindings.encryptedContent,
    })
    .from(aiReviewFindings)
    .where(
      and(
        inArray(
          aiReviewFindings.itemId,
          items.map((item) => item.id),
        ),
        inArray(aiReviewFindings.state, [
          "anchored",
          "unanchored",
          "out_of_scope",
          "ungrounded",
        ]),
      ),
    );
  const findings = await Promise.all(
    rows.slice(0, MAX_PROMPT_FILE_FINDINGS).map(async (row) => {
      try {
        const content = JSON.parse(
          await openVaultSecret(
            {
              workspaceId: input.job.workspaceId,
              recordId: row.id,
              provider: "ai-review-finding",
            },
            row.encryptedContent,
          ),
        ) as { title?: unknown };
        if (typeof content.title !== "string") return undefined;
        return {
          path: row.path ?? DEEP_REVIEW_SURVEY_ITEM_PATH,
          severity: row.severity,
          title: content.title,
        } satisfies SurveyPromptFileFinding;
      } catch {
        return undefined;
      }
    }),
  );
  return findings.filter((finding) => finding !== undefined);
}
