import "server-only";

import { generateText, Output } from "ai";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import {
  aiJobs,
  pullRequests,
  reviewConceptLayouts,
  reviewConceptMembers,
  reviewConcepts,
  reviewSnapshots,
  reviewUnitDependencies,
  reviewUnits,
  signOffs,
} from "@/drizzle/schema";
import { renderAiPromptTemplate } from "~/config/ai-prompt-template";
import type { db as database } from "~/server/db";
import { hydrateReviewUnits } from "~/server/storage/review-units";
import { resolveAiModel } from "./models";
import { loadAiPromptBodies } from "./prompt-store";
import {
  enforceSemanticConceptCaps,
  semanticClusterJobInput,
  semanticPartitionErrors,
  semanticPartitionSchema,
} from "./semantic-partition";
import { createAiJob, settleAiJobQuota, type TokenUsage } from "./service";
import { addAiUsage, providerUsage } from "./usage";

type Database = typeof database;

// One request may be retried once for repair, so each component can cost two
// provider calls. Keep the worst case comfortably inside the route's 800s
// ceiling: exceeding it kills the process before the quota reservation is
// settled, which would permanently consume the reviewer's monthly allowance.
const MAX_SEMANTIC_COMPONENT_REQUESTS = 6;
const SEMANTIC_CLUSTER_BUDGET_MILLISECONDS = 9 * 60_000;

export const SEMANTIC_CLUSTER_TOO_LARGE =
  "This pull request is too large for AI grouping";
export const SEMANTIC_CLUSTER_TIMED_OUT =
  "AI grouping ran out of time before it produced a complete layout";

/** Runs one optional intent-aware refinement and returns a complete safe layout. */
export async function proposeSemanticConceptLayout(
  db: Database,
  input: {
    pullRequestId: string;
    layoutId: string;
    layoutVersion: number;
    userId: string;
    subscribed: boolean;
    planTier?: import("~/server/ai/plan").ManagedAiPlanTier;
  },
) {
  const job = await createAiJob(db, semanticClusterJobInput(input));
  try {
    const [pullRequest, snapshot, layout] = await Promise.all([
      db.query.pullRequests.findFirst({
        where: eq(pullRequests.id, input.pullRequestId),
      }),
      db.query.reviewSnapshots.findFirst({
        where: eq(reviewSnapshots.id, job.snapshotId),
      }),
      db.query.reviewConceptLayouts.findFirst({
        where: and(
          eq(reviewConceptLayouts.id, input.layoutId),
          eq(reviewConceptLayouts.version, input.layoutVersion),
          or(
            eq(reviewConceptLayouts.userId, input.userId),
            isNull(reviewConceptLayouts.userId),
          ),
        ),
      }),
    ]);
    if (!pullRequest || !snapshot || !layout || layout.lockedAt) {
      throw new Error("The review concept layout changed or is locked");
    }
    const activeLayouts = await db
      .select({
        id: reviewConceptLayouts.id,
        userId: reviewConceptLayouts.userId,
      })
      .from(reviewConceptLayouts)
      .where(
        and(
          eq(reviewConceptLayouts.snapshotId, snapshot.id),
          or(
            eq(reviewConceptLayouts.userId, input.userId),
            isNull(reviewConceptLayouts.userId),
          ),
        ),
      );
    const active =
      activeLayouts.find(({ userId }) => userId === input.userId) ??
      activeLayouts.find(({ userId }) => userId === null);
    if (active?.id !== layout.id) {
      throw new Error("A newer personal review concept layout is active");
    }
    const newSignOff = await db
      .select({ id: signOffs.id })
      .from(signOffs)
      .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
      .where(
        and(
          eq(reviewUnits.snapshotId, snapshot.id),
          eq(signOffs.userId, input.userId),
          isNull(signOffs.invalidatedAt),
          gte(signOffs.signedOffAt, snapshot.createdAt),
        ),
      )
      .limit(1);
    if (newSignOff.length > 0) {
      throw new Error("The review concept layout changed or is locked");
    }
    const storedUnits = await db.query.reviewUnits.findMany({
      where: and(
        eq(reviewUnits.snapshotId, snapshot.id),
        inArray(
          reviewUnits.id,
          db
            .select({ id: reviewConceptMembers.unitId })
            .from(reviewConceptMembers)
            .where(eq(reviewConceptMembers.layoutId, layout.id)),
        ),
      ),
      orderBy: [reviewUnits.reviewOrder],
    });
    const hydratedUnits = await hydrateReviewUnits(db, storedUnits);
    const dependencyRows = storedUnits.length
      ? await db
          .select()
          .from(reviewUnitDependencies)
          .where(
            inArray(
              reviewUnitDependencies.unitId,
              storedUnits.map(({ id }) => id),
            ),
          )
      : [];
    const dependenciesByUnit = new Map<string, string[]>();
    for (const dependency of dependencyRows) {
      dependenciesByUnit.set(dependency.unitId, [
        ...(dependenciesByUnit.get(dependency.unitId) ?? []),
        dependency.dependencyId,
      ]);
    }
    const concepts = await db.query.reviewConcepts.findMany({
      where: eq(reviewConcepts.layoutId, layout.id),
      orderBy: [reviewConcepts.reviewOrder],
    });
    const memberships = await db
      .select()
      .from(reviewConceptMembers)
      .where(eq(reviewConceptMembers.layoutId, layout.id));
    const membersByConcept = new Map<string, string[]>();
    for (const member of memberships.sort(
      (left, right) => left.memberOrder - right.memberOrder,
    )) {
      membersByConcept.set(member.conceptId, [
        ...(membersByConcept.get(member.conceptId) ?? []),
        member.unitId,
      ]);
    }
    let excerptBudget = 80_000;
    const manifestUnits = hydratedUnits.map((unit) => {
      const excerpt = unit.source.slice(
        0,
        Math.max(0, Math.min(2_000, excerptBudget)),
      );
      excerptBudget -= Buffer.byteLength(excerpt);
      return {
        id: unit.id,
        stableKey: unit.stableKey,
        path: unit.path,
        kind: unit.kind,
        name: unit.name,
        signature: unit.signature,
        dependencies: dependenciesByUnit.get(unit.id) ?? [],
        changedLineCount: unit.changedLineCount,
        excerpt,
      };
    });
    const manifest = {
      pullRequest: {
        title: pullRequest.title,
        description: pullRequest.description,
      },
      currentConcepts: concepts.map((concept) => ({
        title: concept.title,
        rationale: concept.rationale,
        memberUnitIds: membersByConcept.get(concept.id) ?? [],
      })),
      units: manifestUnits,
    };
    const resolved = await resolveAiModel(db, {
      workspaceId: job.workspaceId,
      provider: job.provider ?? "",
      model: job.model ?? "",
    });
    await db
      .update(aiJobs)
      .set({ status: "running", startedAt: new Date(), progress: 20 })
      .where(eq(aiJobs.id, job.id));
    const prompts = await loadAiPromptBodies(db);
    const system = prompts["semantic.cluster.system"];
    /** Executes one bounded structured semantic-partition request. */
    const run = (prompt: string) =>
      generateText({
        model: resolved.model,
        system,
        prompt,
        output: Output.object({ schema: semanticPartitionSchema }),
        maxOutputTokens: 6_000,
        maxRetries: 0,
        timeout: 120_000,
        providerOptions: resolved.providerOptions,
        telemetry: { isEnabled: false },
      });
    const manifestJson = JSON.stringify(manifest);
    const manifests =
      Buffer.byteLength(manifestJson) <= 120_000
        ? [manifest]
        : manifest.currentConcepts.map((currentConcept) => {
            const ids = new Set(currentConcept.memberUnitIds);
            return {
              pullRequest: manifest.pullRequest,
              currentConcepts: [currentConcept],
              units: manifest.units
                .filter(({ id }) => ids.has(id))
                .map((unit) => ({ ...unit, excerpt: "" })),
            };
          });
    if (manifests.length > MAX_SEMANTIC_COMPONENT_REQUESTS) {
      throw new Error(SEMANTIC_CLUSTER_TOO_LARGE);
    }
    const deadline = Date.now() + SEMANTIC_CLUSTER_BUDGET_MILLISECONDS;
    let accumulatedUsage: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      microUsd: 0,
    };
    const proposedConcepts: Array<
      (typeof semanticPartitionSchema._output)["concepts"][number]
    > = [];
    for (const [componentIndex, component] of manifests.entries()) {
      const componentJson = JSON.stringify(component);
      const unitIds = component.units.map(({ id }) => id);
      // Fail inside the request so the catch below marks the job failed and
      // releases its reservation, rather than being killed mid-flight.
      if (Date.now() >= deadline) throw new Error(SEMANTIC_CLUSTER_TIMED_OUT);
      const result = await run(
        renderAiPromptTemplate(prompts["semantic.cluster.user"], {
          manifest: componentJson,
        }),
      );
      accumulatedUsage = addAiUsage(accumulatedUsage, providerUsage(result));
      let output = result.output;
      let errors = semanticPartitionErrors(unitIds, output.concepts);
      if (
        errors.missing.length ||
        errors.duplicate.length ||
        errors.unknown.length
      ) {
        await db
          .update(aiJobs)
          .set({
            progress: Math.min(
              90,
              30 + Math.floor((componentIndex / manifests.length) * 60),
            ),
          })
          .where(eq(aiJobs.id, job.id));
        const repair = await run(
          renderAiPromptTemplate(prompts["semantic.cluster.repair"], {
            missing: errors.missing.join(","),
            duplicate: errors.duplicate.join(","),
            unknown: errors.unknown.join(","),
            manifest: componentJson,
            proposal: JSON.stringify(output),
          }),
        );
        accumulatedUsage = addAiUsage(accumulatedUsage, providerUsage(repair));
        output = repair.output;
        errors = semanticPartitionErrors(unitIds, output.concepts);
      }
      if (
        errors.missing.length ||
        errors.duplicate.length ||
        errors.unknown.length
      ) {
        throw new Error(
          "AI grouping did not return a complete review partition",
        );
      }
      proposedConcepts.push(...output.concepts);
    }
    const completeErrors = semanticPartitionErrors(
      storedUnits.map(({ id }) => id),
      proposedConcepts,
    );
    if (
      completeErrors.missing.length ||
      completeErrors.duplicate.length ||
      completeErrors.unknown.length
    ) {
      throw new Error("AI grouping did not return a complete review partition");
    }
    const safeConcepts = enforceSemanticConceptCaps(
      proposedConcepts,
      storedUnits,
    );
    await db
      .update(aiJobs)
      .set({
        status: "completed",
        progress: 100,
        completionReason: "answered",
        completedAt: new Date(),
        result: {
          summary: `Prepared ${safeConcepts.length} semantic review concepts.`,
          annotations: [],
          findings: [],
          commentProposals: [],
          concepts: safeConcepts,
        },
      })
      .where(eq(aiJobs.id, job.id));
    await settleAiJobQuota(db, job.id, accumulatedUsage);
    return { jobId: job.id, concepts: safeConcepts };
  } catch (cause) {
    await db
      .update(aiJobs)
      .set({
        status: "failed",
        error: cause instanceof Error ? cause.message : "AI grouping failed",
        completedAt: new Date(),
      })
      .where(eq(aiJobs.id, job.id));
    await settleAiJobQuota(db, job.id);
    throw cause;
  }
}
