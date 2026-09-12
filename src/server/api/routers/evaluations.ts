import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { z } from "zod";
import {
  aiJobs,
  aiReviewFindings,
  evalCases,
  evalDatasets,
  evalResults,
  evalRuns,
  localAiConfigurations,
  snapshotFiles,
  sourceBlobs,
} from "@/drizzle/schema";
import {
  type EvalCase,
  type EvalOutput,
  evalCaseSchema,
  evalMetrics,
} from "~/lib/evaluations";
import { managedSaasModel } from "~/server/ai/plan";
import { loadAiPromptBodies } from "~/server/ai/prompt-store";
import { isLocalDeployment } from "~/server/deployment";
import {
  evaluationAccess,
  requireEvaluationAccess,
} from "~/server/evaluations/access";
import {
  type EvalSnapshot,
  openEval,
  sealEval,
} from "~/server/evaluations/store";
import { openVaultSecret } from "~/server/security/vault";
import { readSourceText } from "~/server/storage/source-blobs";
import { evaluationWorkflow } from "~/server/workflows/evaluation";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const evaluationProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const workspace = await requireEvaluationAccess(ctx.db, ctx.auth.userId);
  return next({ ctx: { ...ctx, evaluationWorkspace: workspace } });
});
const datasetProcedure = evaluationProcedure
  .input(z.object({ datasetId: z.uuid() }))
  .use(async ({ ctx, input, next }) => {
    const dataset = await ctx.db.query.evalDatasets.findFirst({
      where: and(
        eq(evalDatasets.id, input.datasetId),
        eq(evalDatasets.workspaceId, ctx.evaluationWorkspace.id),
      ),
    });
    if (!dataset) throw new TRPCError({ code: "NOT_FOUND" });
    return next({ ctx: { ...ctx, dataset } });
  });
const runProcedure = datasetProcedure
  .input(z.object({ runId: z.uuid() }))
  .use(async ({ ctx, input, next }) => {
    const run = await ctx.db.query.evalRuns.findFirst({
      where: and(
        eq(evalRuns.id, input.runId),
        eq(evalRuns.datasetId, ctx.dataset.id),
      ),
    });
    if (!run) throw new TRPCError({ code: "NOT_FOUND" });
    const snapshot = await openEval<EvalSnapshot>(
      ctx.dataset.workspaceId,
      run.id,
      run.encryptedSnapshot,
    );
    return next({ ctx: { ...ctx, run, snapshot } });
  });

export const evaluationsRouter = createTRPCRouter({
  access: protectedProcedure.query(async ({ ctx }) => ({
    allowed: (await evaluationAccess(ctx.db, ctx.auth.userId)).allowed,
  })),
  list: evaluationProcedure.query(async ({ ctx }) =>
    ctx.db.query.evalDatasets.findMany({
      where: eq(evalDatasets.workspaceId, ctx.evaluationWorkspace.id),
      orderBy: desc(evalDatasets.createdAt),
    }),
  ),
  create: evaluationProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(2000).default(""),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(evalDatasets)
        .values({ ...input, workspaceId: ctx.evaluationWorkspace.id })
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return row;
    }),
  rename: datasetProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(evalDatasets)
        .set({ name: input.name, description: input.description })
        .where(eq(evalDatasets.id, ctx.dataset.id));
    }),
  detail: datasetProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.query.evalCases.findMany({
      where: eq(evalCases.datasetId, ctx.dataset.id),
      orderBy: desc(evalCases.updatedAt),
    });
    const cases = await Promise.all(
      rows.map(async (row) => ({
        ...caseSummary(
          await openEval<EvalCase>(
            ctx.dataset.workspaceId,
            row.id,
            row.encryptedContent,
          ),
        ),
        id: row.id,
      })),
    );
    const runs = await ctx.db.query.evalRuns.findMany({
      where: eq(evalRuns.datasetId, ctx.dataset.id),
      orderBy: desc(evalRuns.createdAt),
      columns: { encryptedSnapshot: false },
      limit: 100,
    });
    return { ...ctx.dataset, cases, runs };
  }),
  case: datasetProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.query.evalCases.findFirst({
        where: and(
          eq(evalCases.id, input.id),
          eq(evalCases.datasetId, ctx.dataset.id),
        ),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return {
        ...(await openEval<EvalCase>(
          ctx.dataset.workspaceId,
          row.id,
          row.encryptedContent,
        )),
        id: row.id,
      };
    }),
  runCase: runProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => {
      const example = ctx.snapshot.cases.find((row) => row.id === input.id);
      if (!example) throw new TRPCError({ code: "NOT_FOUND" });
      return example;
    }),
  saveCase: datasetProcedure
    .input(z.object({ id: z.uuid().optional(), example: evalCaseSchema }))
    .mutation(async ({ ctx, input }) => {
      const id = input.id ?? randomUUID();
      const encryptedContent = await sealEval(
        ctx.dataset.workspaceId,
        id,
        input.example,
      );
      if (input.id) {
        const updated = await ctx.db
          .update(evalCases)
          .set({ encryptedContent, updatedAt: new Date() })
          .where(
            and(eq(evalCases.id, id), eq(evalCases.datasetId, ctx.dataset.id)),
          )
          .returning({ id: evalCases.id });
        if (!updated.length) throw new TRPCError({ code: "NOT_FOUND" });
      } else {
        await ctx.db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`eval-cases:${ctx.dataset.id}`}))`,
          );
          const count = await tx.$count(
            evalCases,
            eq(evalCases.datasetId, ctx.dataset.id),
          );
          if (count >= 200)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "A dataset can contain up to 200 cases",
            });
          await tx
            .insert(evalCases)
            .values({ id, datasetId: ctx.dataset.id, encryptedContent });
        });
      }
      return { id };
    }),
  deleteCase: datasetProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(evalCases)
        .where(
          and(
            eq(evalCases.id, input.id),
            eq(evalCases.datasetId, ctx.dataset.id),
          ),
        );
    }),
  finding: evaluationProcedure
    .input(z.object({ findingId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.query.aiReviewFindings.findFirst({
        where: and(
          eq(aiReviewFindings.id, input.findingId),
          eq(aiReviewFindings.workspaceId, ctx.evaluationWorkspace.id),
        ),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!row.path)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Cross-file findings need a manually curated example with sufficient context",
        });
      const content = JSON.parse(
        await openVaultSecret(
          {
            workspaceId: row.workspaceId,
            recordId: row.id,
            provider: "ai-review-finding",
          },
          row.encryptedContent,
        ),
      ) as { title: string; body: string; existingCode: string };
      const job = await ctx.db.query.aiJobs.findFirst({
        where: and(
          eq(aiJobs.id, row.jobId),
          eq(aiJobs.workspaceId, row.workspaceId),
        ),
      });
      const file = job?.snapshotId
        ? await ctx.db.query.snapshotFiles.findFirst({
            where: and(
              eq(snapshotFiles.snapshotId, job.snapshotId),
              eq(snapshotFiles.path, row.path),
            ),
          })
        : undefined;
      if (!file)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Original source is no longer available. Create a case with code context manually.",
        });
      /** Reads a retained source blob without fetching newer repository content. */
      const source = async (id: string | null) => {
        if (!id) return "";
        const blob = await ctx.db.query.sourceBlobs.findFirst({
          where: and(
            eq(sourceBlobs.id, id),
            eq(sourceBlobs.workspaceId, row.workspaceId),
          ),
        });
        if (!blob)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Original source is unavailable",
          });
        return readSourceText(blob);
      };
      const [current, previous] = await Promise.all([
        source(file.currentBlobId),
        source(file.previousBlobId),
      ]);
      if (!current && !previous)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Original source is no longer available. Create a case with code context manually.",
        });
      return evalCaseSchema.parse({
        title: content.title,
        path: row.path,
        finding: content.body,
        existingCode: content.existingCode,
        source: current || previous,
        previousSource: previous,
        label: "unlabeled",
        sourceFindingId: row.id,
      });
    }),
  prompts: evaluationProcedure.query(async ({ ctx }) => {
    const prompts = await loadAiPromptBodies(ctx.db);
    return {
      discovery: prompts["deep_review.scout.system_repository"],
      verification: prompts["deep_review.refute.system"],
    };
  }),
  startRun: datasetProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        mode: z.enum(["discovery", "verification"]),
        split: z.enum(["development", "holdout"]),
        prompt: z.string().trim().min(1).max(50_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.query.evalCases.findMany({
        where: eq(evalCases.datasetId, ctx.dataset.id),
      });
      const cases = (
        await Promise.all(
          rows.map(async (row) => ({
            ...(await openEval<EvalCase>(
              ctx.dataset.workspaceId,
              row.id,
              row.encryptedContent,
            )),
            id: row.id,
          })),
        )
      ).filter((row) => row.label !== "unlabeled" && row.split === input.split);
      if (!cases.length || cases.length > 50)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Select a split with between 1 and 50 labeled cases",
        });
      const local = isLocalDeployment();
      const configuration = local
        ? await ctx.db.query.localAiConfigurations.findFirst({
            where: eq(
              localAiConfigurations.workspaceId,
              ctx.dataset.workspaceId,
            ),
          })
        : null;
      if (local && !configuration)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Configure an AI provider in AI assistant settings first",
        });
      const prompts = await loadAiPromptBodies(ctx.db);
      prompts[
        input.mode === "discovery"
          ? "deep_review.scout.system_repository"
          : "deep_review.refute.system"
      ] = input.prompt;
      const snapshot: EvalSnapshot = {
        version: 1,
        mode: input.mode,
        split: input.split,
        provider: configuration?.provider ?? "openrouter",
        model: configuration?.model ?? managedSaasModel(),
        prompts,
        cases,
      };
      const id = randomUUID();
      const encryptedSnapshot = await sealEval(
        ctx.dataset.workspaceId,
        id,
        snapshot,
      );
      await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`eval-run:${ctx.dataset.workspaceId}`}))`,
        );
        const active = await tx
          .select({ id: evalRuns.id })
          .from(evalRuns)
          .innerJoin(evalDatasets, eq(evalDatasets.id, evalRuns.datasetId))
          .where(
            and(
              eq(evalDatasets.workspaceId, ctx.dataset.workspaceId),
              eq(evalRuns.status, "running"),
            ),
          )
          .limit(1);
        if (active.length)
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "An evaluation is already running. Wait or cancel it before starting another.",
          });
        await tx.insert(evalRuns).values({
          id,
          datasetId: ctx.dataset.id,
          name: input.name,
          encryptedSnapshot,
        });
      });
      try {
        await start(evaluationWorkflow, [id, cases.map((row) => row.id)]);
      } catch {
        await ctx.db
          .update(evalRuns)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(evalRuns.id, id));
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not start evaluation",
        });
      }
      return { id };
    }),
  run: runProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.query.evalResults.findMany({
      where: eq(evalResults.runId, ctx.run.id),
    });
    const outputs = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        caseId: row.caseId,
        ...(await openEval<EvalOutput>(
          ctx.dataset.workspaceId,
          row.id,
          row.encryptedOutput,
        )),
      })),
    );
    const cases = ctx.snapshot.cases.map((example) => ({
      ...caseSummary(example),
      id: example.id,
      result: outputs.find((output) => output.caseId === example.id) ?? null,
    }));
    return {
      id: ctx.run.id,
      name: ctx.run.name,
      status: ctx.run.status,
      createdAt: ctx.run.createdAt,
      snapshot: {
        version: ctx.snapshot.version,
        mode: ctx.snapshot.mode,
        split: ctx.snapshot.split,
        model: ctx.snapshot.model,
        provider: ctx.snapshot.provider,
        prompts: ctx.snapshot.prompts,
        casesFingerprint: createHash("sha256")
          .update(
            JSON.stringify(
              [...ctx.snapshot.cases].sort((a, b) => a.id.localeCompare(b.id)),
            ),
          )
          .digest("hex"),
      },
      cases,
      metrics: evalMetrics(
        cases
          .filter((row) => row.result)
          .map((row) => ({
            label: row.label,
            prediction: row.result?.prediction ?? "ungraded",
          })),
      ),
    };
  }),
  cancel: runProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(evalRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(and(eq(evalRuns.id, ctx.run.id), eq(evalRuns.status, "running")));
  }),
  grade: runProcedure
    .input(
      z.object({
        resultId: z.uuid(),
        prediction: z.enum(["report", "suppress", "ungraded"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.snapshot.mode !== "discovery")
        throw new TRPCError({ code: "BAD_REQUEST" });
      const result = await ctx.db.query.evalResults.findFirst({
        where: and(
          eq(evalResults.id, input.resultId),
          eq(evalResults.runId, ctx.run.id),
        ),
      });
      if (!result) throw new TRPCError({ code: "NOT_FOUND" });
      const output = await openEval<EvalOutput>(
        ctx.dataset.workspaceId,
        result.id,
        result.encryptedOutput,
      );
      if (output.prediction === "error")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Failed cases cannot be graded",
        });
      await ctx.db
        .update(evalResults)
        .set({
          encryptedOutput: await sealEval(ctx.dataset.workspaceId, result.id, {
            ...output,
            prediction: input.prediction,
            originalPrediction: output.originalPrediction ?? output.prediction,
            gradedBy: ctx.auth.userId,
            gradedAt: new Date().toISOString(),
          }),
        })
        .where(eq(evalResults.id, result.id));
    }),
});

/** Omits code bodies from frequently refreshed case lists and results. */
function caseSummary(example: EvalCase) {
  const {
    source: _source,
    previousSource: _previous,
    existingCode: _code,
    ...summary
  } = example;
  return summary;
}
