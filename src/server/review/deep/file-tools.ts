import "server-only";

import { tool } from "@ai-sdk/provider-utils";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  aiJobEvidence,
  type aiJobs,
  aiJobToolCalls,
  aiReviewFindings,
  type aiReviewItems,
  type sourceBlobs,
} from "@/drizzle/schema";
import { env } from "~/env";
import { sideBySideDiff } from "~/lib/side-by-side-diff";
import { untrustedFileSource } from "~/server/ai/untrusted-content";
import type { db as database } from "~/server/db";
import { sealVaultSecret } from "~/server/security/vault";
import type { DeepReviewContext } from "./context";
import { findingCapacity } from "./finding-cap";
import {
  deepReviewFindingId,
  normalizeFindingCategory,
  normalizeFindingSeverity,
} from "./findings";

type Database = typeof database;

const MAX_FINDINGS_PER_FILE = 25;
const MAX_FINDINGS_PER_CALL = 10;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 4_000;
const MAX_SNIPPET_LENGTH = 4_000;
const MAX_SUMMARY_LENGTH = 2_000;
const DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 1_200;
const MAX_LISTED_PATHS = 500;
const MAX_POLICY_CHECKED_PATHS = 2_000;
const MAX_SEARCH_EXCERPT = 1_000;
const MAX_READ_FILE_BYTES = 1_000_000;

export interface DeepReviewToolInvocation {
  name: string;
  callId: string;
  arguments: unknown;
  execute: () => Promise<unknown>;
}

/**
 * Runs one tool body under the caller's durability and concurrency discipline.
 *
 * The child agent owns `persistToolCall` and the semaphore, so the tools take
 * the wrapper rather than reaching back into the loop that drives them.
 */
export type DeepReviewToolExecutor = (
  invocation: DeepReviewToolInvocation,
) => Promise<unknown>;

export interface DeepReviewToolLimits {
  maxSourceBytes?: number;
  maxDistinctFiles?: number;
  maxFindings?: number;
}

export interface DeepReviewFileToolContext {
  db: Database;
  /** The child job reviewing exactly one file. */
  job: typeof aiJobs.$inferSelect;
  item: Pick<typeof aiReviewItems.$inferSelect, "id" | "path">;
  repository: DeepReviewContext;
  execute: DeepReviewToolExecutor;
  limits?: DeepReviewToolLimits;
  /** Source bytes already charged to this run before the current turn. */
  sourceBytesRead?: number;
  readPaths?: Iterable<string>;
  reportedFindings?: number;
  onFinishFile?: (input: { summary: string }) => void;
}

const deepReviewReportFindingSchema = z.object({
  findings: z
    .array(
      z.object({
        title: z.string().min(1).max(MAX_TITLE_LENGTH),
        body: z.string().min(1).max(MAX_BODY_LENGTH),
        // Anchoring derives lines from this snippet, so a reported line number
        // would be a second source of truth the model is worst placed to give.
        existing_code: z.string().min(1).max(MAX_SNIPPET_LENGTH),
        // Free strings, normalized after the fact: an unknown severity must
        // degrade the finding, never fail the whole tool call.
        severity: z
          .string()
          .max(32)
          .describe("One of: critical, high, medium, low."),
        category: z
          .string()
          .max(32)
          .describe(
            "One of: bug, security, performance, maintainability, test, style, documentation, other.",
          ),
        suggestion_code: z.string().max(MAX_SNIPPET_LENGTH).optional(),
      }),
    )
    .min(1)
    .max(MAX_FINDINGS_PER_CALL),
});

interface DiffHunk {
  previousStart: number;
  previousLines: number;
  currentStart: number;
  currentLines: number;
  lines: string[];
}

/** Splits source into lines without inventing one for empty text. */
function sourceLines(source: string): string[] {
  return source === "" ? [] : source.split("\n");
}

/** Maps one-based line numbers onto their byte offsets in the same text. */
function lineByteOffsets(lines: readonly string[]): number[] {
  const offsets = [0];
  for (const line of lines) {
    offsets.push((offsets.at(-1) ?? 0) + Buffer.byteLength(line) + 1);
  }
  return offsets;
}

/** Converts an inclusive line range into the byte range evidence records. */
function lineRangeBytes(
  offsets: readonly number[],
  startLine: number,
  endLine: number,
) {
  const start = offsets[Math.max(0, startLine - 1)] ?? 0;
  const end = Math.max(start, (offsets[endLine] ?? start) - 1);
  return { startByte: start, endByte: end };
}

/** Renders every line of a wholly added or wholly deleted file as one hunk. */
function wholeFileHunk(source: string, marker: "+" | "-"): DiffHunk[] {
  const lines = sourceLines(source);
  if (lines.length === 0) return [];
  const rendered = lines
    .slice(0, MAX_DIFF_LINES)
    .map((line) => `${marker}${line}`);
  return [
    {
      previousStart: marker === "-" ? 1 : 0,
      previousLines: marker === "-" ? rendered.length : 0,
      currentStart: marker === "+" ? 1 : 0,
      currentLines: marker === "+" ? rendered.length : 0,
      lines: rendered,
    },
  ];
}

/**
 * Builds context-bounded hunks from the same diff the reviewer UI displays.
 *
 * The scout anchors findings by quoting code, so the diff it reads has to be
 * the diff the anchor tiers search rather than a separately computed one.
 */
function diffHunks(
  previousSource: string | undefined,
  currentSource: string | undefined,
): DiffHunk[] {
  if (!previousSource) return wholeFileHunk(currentSource ?? "", "+");
  if (!currentSource) return wholeFileHunk(previousSource, "-");
  const previousLines = sourceLines(previousSource);
  const currentLines = sourceLines(currentSource);
  const rows = sideBySideDiff(previousSource, currentSource);
  const kept = rows.map((_, index) =>
    rows
      .slice(
        Math.max(0, index - DIFF_CONTEXT_LINES),
        index + DIFF_CONTEXT_LINES + 1,
      )
      .some((row) => row.kind !== "unchanged"),
  );
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let rendered = 0;
  // A hunk that opens on an inserted line has no line number of its own on the
  // previous side, so each side carries the index its next line would take.
  let nextPrevious = 0;
  let nextCurrent = 0;
  for (const [index, row] of rows.entries()) {
    const previous =
      row.previousIndex === undefined
        ? undefined
        : (previousLines[row.previousIndex] ?? "");
    const current =
      row.currentIndex === undefined
        ? undefined
        : (currentLines[row.currentIndex] ?? "");
    if (!kept[index] || rendered >= MAX_DIFF_LINES) {
      hunk = undefined;
    } else {
      if (!hunk) {
        hunk = {
          previousStart: (row.previousIndex ?? nextPrevious) + 1,
          previousLines: 0,
          currentStart: (row.currentIndex ?? nextCurrent) + 1,
          currentLines: 0,
          lines: [],
        };
        hunks.push(hunk);
      }
      if (row.kind === "unchanged") {
        hunk.lines.push(` ${current ?? previous ?? ""}`);
        rendered += 1;
      } else {
        if (previous !== undefined) hunk.lines.push(`-${previous}`);
        if (current !== undefined) hunk.lines.push(`+${current}`);
        rendered +=
          (previous === undefined ? 0 : 1) + (current === undefined ? 0 : 1);
      }
      if (previous !== undefined) hunk.previousLines += 1;
      if (current !== undefined) hunk.currentLines += 1;
    }
    if (row.previousIndex !== undefined) nextPrevious = row.previousIndex + 1;
    if (row.currentIndex !== undefined) nextCurrent = row.currentIndex + 1;
  }
  return hunks;
}

/** Renders hunks as the unified patch text the model reads. */
function renderHunks(hunks: readonly DiffHunk[]): string {
  return hunks
    .map((hunk) =>
      [
        `@@ -${hunk.previousStart},${hunk.previousLines} +${hunk.currentStart},${hunk.currentLines} @@`,
        ...hunk.lines,
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Builds the read-only tool set one file scout runs with.
 *
 * Every tool that returns repository text applies the source policy and the
 * untrusted-data framing.
 */
export function deepReviewFileTools(context: DeepReviewFileToolContext) {
  const { db, job, item, repository } = context;
  const maxSourceBytes =
    context.limits?.maxSourceBytes ?? env.AI_MAX_SOURCE_BYTES;
  const maxDistinctFiles =
    context.limits?.maxDistinctFiles ?? env.AI_MAX_DISTINCT_FILES;
  const maxFindings = context.limits?.maxFindings ?? MAX_FINDINGS_PER_FILE;
  const readPaths = new Set(context.readPaths ?? []);
  const consumedBytes = context.sourceBytesRead ?? 0;
  let newSourceBytes = 0;
  const findings = findingCapacity(maxFindings, context.reportedFindings ?? 0);
  let finished = false;

  /** Charges source text against the run's exposure ceiling exactly once. */
  const chargeBytes = (bytes: number) => {
    if (consumedBytes + newSourceBytes + bytes > maxSourceBytes) return false;
    newSourceBytes += bytes;
    return true;
  };

  /** Records the byte range a finding may later be grounded against. */
  const recordEvidence = async (input: {
    path: string;
    blob: typeof sourceBlobs.$inferSelect;
    snapshotFileId?: string;
    startByte: number;
    endByte: number;
    startLine: number;
    endLine: number;
  }) => {
    await db
      .insert(aiJobEvidence)
      .values({
        jobId: job.id,
        snapshotFileId: input.snapshotFileId,
        sourceBlobId: input.blob.id,
        path: input.path,
        digest: input.blob.digest,
        startByte: input.startByte,
        endByte: input.endByte,
        startLine: input.startLine,
        endLine: input.endLine,
      })
      .onConflictDoNothing();
  };

  return {
    list_files: tool({
      description:
        "List files in the exact review revision, with the symbols this pull request changed. Use it to map dependencies before reading.",
      inputSchema: z.object({ query: z.string().max(200).optional() }),
      execute: (input, options) =>
        context.execute({
          name: "list_files",
          callId: options.toolCallId,
          arguments: input,
          execute: async () => {
            const query = input.query?.toLowerCase();
            const units = await repository.units();
            const changed = new Map<string, Array<Record<string, unknown>>>();
            for (const unit of units) {
              changed.set(unit.path, [
                ...(changed.get(unit.path) ?? []),
                {
                  symbol: unit.name,
                  kind: unit.kind,
                  lines: [unit.startLine, unit.endLine],
                  changeType: unit.changeType,
                },
              ]);
            }
            const matched = (await repository.listFiles())
              .filter(
                (path) =>
                  !query ||
                  path.toLowerCase().includes(query) ||
                  (changed.get(path) ?? []).some((symbol) =>
                    String(symbol.symbol).toLowerCase().includes(query),
                  ),
              )
              .slice(0, MAX_POLICY_CHECKED_PATHS);
            const decisions = await Promise.all(
              matched.map((path) => repository.sourceDecision(path, "")),
            );
            return matched
              .filter((_, index) => decisions[index]?.allowed)
              .slice(0, MAX_LISTED_PATHS)
              .map((path) => ({
                path,
                changedSymbols: (changed.get(path) ?? []).slice(0, 25),
              }));
          },
        }),
    }),
    search_code: tool({
      description:
        "Search the changed source of this pull request with a literal, case-insensitive query.",
      inputSchema: z.object({
        query: z.string().min(2).max(300),
        pathPrefix: z.string().max(1_000).optional(),
      }),
      execute: (input, options) =>
        context.execute({
          name: "search_code",
          callId: options.toolCallId,
          arguments: input,
          execute: async () => {
            const hits = await repository.searchCode(input);
            const decisions = await Promise.all(
              hits.map((hit) =>
                repository.sourceDecision(hit.path, hit.source),
              ),
            );
            return hits
              .filter((_, index) => decisions[index]?.allowed)
              .map((hit) => ({
                path: hit.path,
                symbol: hit.symbol,
                line: hit.startLine,
                excerpt: untrustedFileSource(
                  hit.path,
                  hit.source.slice(0, MAX_SEARCH_EXCERPT),
                ),
              }));
          },
        }),
    }),
    read_diff: tool({
      description:
        "Read the unified diff for the file under review, or for another file this pull request changed.",
      inputSchema: z.object({
        path: z.string().min(1).max(2_000).optional(),
      }),
      execute: (input, options) =>
        context.execute({
          name: "read_diff",
          callId: options.toolCallId,
          arguments: input,
          execute: async () => {
            const path = input.path ?? item.path;
            const file = repository.changedFile(path);
            if (!file) {
              return { error: "This pull request does not change that file" };
            }
            const current = await repository.readFile(
              path,
              Math.min(
                Math.max(0, maxSourceBytes - consumedBytes - newSourceBytes),
                MAX_READ_FILE_BYTES,
              ),
            );
            const previous = await repository.readPreviousSource(path);
            const decision = await repository.sourceDecision(
              path,
              `${current?.source ?? ""}\n${previous ?? ""}`,
            );
            if (!decision.allowed) {
              return {
                error: "File is protected by the source policy",
              };
            }
            const hunks = diffHunks(previous, current?.source);
            if (hunks.length === 0) {
              return { path, changeType: file.changeType, diff: "" };
            }
            const rendered = renderHunks(hunks);
            if (!chargeBytes(Buffer.byteLength(rendered))) {
              return { limit: "source_bytes" };
            }
            readPaths.add(path);
            const currentOffsets = lineByteOffsets(
              sourceLines(current?.source ?? ""),
            );
            const previousOffsets = lineByteOffsets(
              sourceLines(previous ?? ""),
            );
            for (const hunk of hunks) {
              if (current && hunk.currentLines > 0) {
                await recordEvidence({
                  path,
                  blob: current.blob,
                  snapshotFileId: current.snapshotFileId,
                  ...lineRangeBytes(
                    currentOffsets,
                    hunk.currentStart,
                    hunk.currentStart + hunk.currentLines - 1,
                  ),
                  startLine: hunk.currentStart,
                  endLine: hunk.currentStart + hunk.currentLines - 1,
                });
              }
              if (file.previousBlob && hunk.previousLines > 0) {
                await recordEvidence({
                  path,
                  blob: file.previousBlob,
                  snapshotFileId: file.snapshotFileId,
                  ...lineRangeBytes(
                    previousOffsets,
                    hunk.previousStart,
                    hunk.previousStart + hunk.previousLines - 1,
                  ),
                  startLine: hunk.previousStart,
                  endLine: hunk.previousStart + hunk.previousLines - 1,
                });
              }
            }
            return {
              path,
              changeType: file.changeType,
              previousPath: file.previousPath ?? undefined,
              diff: untrustedFileSource(path, rendered),
            };
          },
        }),
    }),
    read_file: tool({
      description:
        "Read a bounded line range from any file in the exact review revision.",
      inputSchema: z
        .object({
          path: z.string().min(1).max(2_000),
          startLine: z.number().int().positive().default(1),
          endLine: z.number().int().positive().max(100_000),
        })
        .refine(
          ({ startLine, endLine }) =>
            endLine >= startLine && endLine - startLine <= 4_000,
          "Read ranges must contain at most 4,001 lines",
        ),
      execute: (input, options) =>
        context.execute({
          name: "read_file",
          callId: options.toolCallId,
          arguments: input,
          execute: async () => {
            if (
              !readPaths.has(input.path) &&
              readPaths.size >= maxDistinctFiles
            ) {
              return { limit: "distinct_files" };
            }
            const remainingBytes =
              maxSourceBytes - consumedBytes - newSourceBytes;
            if (remainingBytes <= 0) return { limit: "source_bytes" };
            const file = await repository.readFile(
              input.path,
              Math.min(remainingBytes, MAX_READ_FILE_BYTES),
            );
            if (!file) {
              return {
                error:
                  "File is absent, binary, too large, or unavailable in this exact revision",
              };
            }
            const decision = await repository.sourceDecision(
              input.path,
              file.source,
            );
            if (!decision.allowed) {
              return {
                error: "File is protected by the source policy",
              };
            }
            const lines = file.source.match(/[^\n]*(?:\n|$)/g) ?? [];
            const before = lines
              .slice(0, Math.max(0, input.startLine - 1))
              .join("");
            const source = lines
              .slice(Math.max(0, input.startLine - 1), input.endLine)
              .join("")
              .replace(/\n$/, "");
            const startByte = Buffer.byteLength(before);
            const bytes = Buffer.byteLength(source);
            if (!chargeBytes(bytes)) return { limit: "source_bytes" };
            readPaths.add(input.path);
            const endLine =
              input.startLine + Math.max(0, source.split("\n").length - 1);
            await recordEvidence({
              path: input.path,
              blob: file.blob,
              snapshotFileId: file.snapshotFileId,
              startByte,
              endByte: startByte + bytes,
              startLine: input.startLine,
              endLine,
            });
            return {
              path: input.path,
              startLine: input.startLine,
              endLine,
              source: untrustedFileSource(input.path, source),
            };
          },
        }),
    }),
    report_finding: tool({
      description:
        "Report one or more defects in the file under review. Quote the exact existing code each defect is in; never report a line number.",
      inputSchema: deepReviewReportFindingSchema,
      execute: (input, options) =>
        context.execute({
          name: "report_finding",
          callId: options.toolCallId,
          arguments: input,
          execute: () =>
            findings.withReservation(input.findings.length, async (count) => {
              // The rows are written here, inside the tool body, because a
              // replayed durable step returns the stored tool output without
              // re-running this handler. Findings buffered for a post-turn flush
              // would silently vanish on every replay.
              const accepted = input.findings.slice(0, count);
              const rows = await Promise.all(
                accepted.map(async (finding, index) => {
                  const id = deepReviewFindingId({
                    toolCallId: options.toolCallId,
                    index,
                  });
                  return {
                    id,
                    itemId: item.id,
                    jobId: job.id,
                    workspaceId: job.workspaceId,
                    path: item.path,
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
                        existingCode: finding.existing_code,
                        suggestionCode: finding.suggestion_code,
                      }),
                    ),
                  };
                }),
              );
              if (rows.length > 0) {
                await db
                  .insert(aiReviewFindings)
                  .values(rows)
                  .onConflictDoNothing();
              }
              return {
                accepted: rows.length,
                declined: input.findings.length - rows.length,
                findingIds: rows.map((row) => row.id),
              };
            }),
        }),
    }),
    finish_file: tool({
      description:
        "Declare the review of this file complete. Call it once, after every finding has been reported.",
      inputSchema: z.object({
        summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
      }),
      execute: (input, options) =>
        context.execute({
          name: "finish_file",
          callId: options.toolCallId,
          arguments: input,
          execute: async () => {
            if (finished) {
              return {
                accepted: false,
                error: "This file was already finished",
              };
            }
            finished = true;
            context.onFinishFile?.({ summary: input.summary });
            return { accepted: true };
          },
        }),
    }),
  };
}

/**
 * Reports whether a file scout already declared itself finished.
 *
 * The in-process `onFinishFile` callback does not fire for a replayed step, so
 * the durable tool-call row is what a resumed turn has to consult.
 */
export async function deepReviewFileFinished(
  db: Database,
  jobId: string,
): Promise<boolean> {
  const call = await db.query.aiJobToolCalls.findFirst({
    where: and(
      eq(aiJobToolCalls.jobId, jobId),
      eq(aiJobToolCalls.toolName, "finish_file"),
      eq(aiJobToolCalls.status, "completed"),
    ),
  });
  return Boolean(call);
}
