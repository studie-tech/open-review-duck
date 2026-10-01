import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { EvalCase, EvalOutput } from "~/lib/evaluations";
import type { ResolvedAiModel } from "~/server/ai/models";
import { deepReviewPromptBodies } from "~/server/ai/prompt-store";
import { deepReviewReportFindingSchema } from "~/server/review/deep/file-tools";
import { applyRefuteVerdicts } from "~/server/review/deep/refute-policy";
import {
  refuteUserPrompt,
  scoutUserPrompt,
} from "~/server/review/deep/review-prompts";
import { parseRefuteVotes } from "~/server/review/deep/validate";
import type { EvalSnapshot } from "./store";

/** Runs the production scout or refuter prompts against immutable file context. */
export async function evaluateCase(
  snapshot: EvalSnapshot,
  example: EvalCase & { id: string },
  model: ResolvedAiModel,
): Promise<EvalOutput> {
  const bodies = deepReviewPromptBodies(snapshot.prompts);
  const common = {
    ...model,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(90_000),
  };
  if (snapshot.mode === "verification") {
    const response = await generateText({
      ...common,
      system: snapshot.prompts["deep_review.refute.system"],
      prompt: refuteUserPrompt(
        {
          path: example.path,
          findings: [
            {
              id: example.id,
              content: example.finding,
              existingCode: example.existingCode,
            },
          ],
          currentSource: example.source,
          previousSource: example.previousSource || null,
        },
        bodies,
      ),
    });
    const votes = parseRefuteVotes(response.text);
    const verdict = applyRefuteVerdicts({
      votes: votes ?? [],
      findingIds: [example.id],
      snapshotPaths: [example.path],
    }).get(example.id);
    // An invalid response is an execution failure, never a successful rejection.
    return {
      prediction:
        verdict?.verdict === "unverified"
          ? "error"
          : verdict?.verdict === "refuted"
            ? "suppress"
            : "report",
      output: response.text,
      inputTokens: response.totalUsage.inputTokens ?? 0,
      outputTokens: response.totalUsage.outputTokens ?? 0,
    };
  }
  const findings: z.infer<typeof deepReviewReportFindingSchema>["findings"] =
    [];
  let finished = false;
  const response = await generateText({
    ...common,
    system: snapshot.prompts["deep_review.scout.system_repository"],
    prompt: scoutUserPrompt(
      {
        path: example.path,
        changeType: "modified",
        rulebookText: "",
        currentSource: example.source,
        previousSource: null,
        changedRanges: [
          { startLine: 1, endLine: example.source.split("\n").length },
        ],
        unitManifest: [],
        pullRequest: {
          title: "Frozen-file evaluation",
          sourceBranch: "snapshot",
          targetBranch: "snapshot",
        },
        reviewScope: "repository_snapshot",
      },
      bodies,
    ),
    stopWhen: [stepCountIs(6), () => finished],
    tools: {
      report_finding: tool({
        description:
          "Report defects in the frozen file. Quote exact existing code.",
        inputSchema: deepReviewReportFindingSchema,
        execute: async (input) => {
          const accepted = input.findings.slice(
            0,
            Math.max(0, 20 - findings.length),
          );
          findings.push(...accepted);
          return { accepted: accepted.length };
        },
      }),
      finish_file: tool({
        description:
          "Declare the file review complete after reporting findings.",
        inputSchema: z.object({ summary: z.string().max(2000) }),
        execute: async () => {
          finished = true;
          return { accepted: true };
        },
      }),
      read_file: tool({
        description:
          "Read the frozen file. Other repository files are unavailable in this evaluation.",
        inputSchema: z.object({
          path: z.string(),
          startLine: z.number().int().min(1).default(1),
          endLine: z.number().int().min(1).optional(),
        }),
        execute: async (input) =>
          input.path === example.path
            ? {
                source: example.source
                  .split("\n")
                  .slice(input.startLine - 1, input.endLine)
                  .join("\n"),
              }
            : { error: "File is outside the frozen evaluation context" },
      }),
    },
  });
  return {
    prediction: !finished ? "error" : findings.length ? "ungraded" : "suppress",
    output: JSON.stringify(
      { completed: finished, findings, summary: response.text },
      null,
      2,
    ),
    inputTokens: response.totalUsage.inputTokens ?? 0,
    outputTokens: response.totalUsage.outputTokens ?? 0,
  };
}
