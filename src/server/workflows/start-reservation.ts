import { randomUUID } from "node:crypto";

export const WORKFLOW_START_LEASE_MS = 30_000;

export type WorkflowStartReservation<TClaim, TResult> =
  | { state: "linked"; result: TResult }
  | { state: "pending"; leaseExpiresAt: Date }
  | {
      state: "claimed";
      claim: TClaim;
      startToken: string;
      leaseExpiresAt: Date;
    };

interface WorkflowStartTarget {
  workflowRunId: string | null;
  workflowStartLeaseExpiresAt: Date | null;
}

/** Creates the lease values persisted when a caller takes responsibility for a start. */
export function newWorkflowStartLease(now = new Date()) {
  return {
    startToken: randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + WORKFLOW_START_LEASE_MS),
  };
}

/** Inspects and, when necessary, reclaims one persisted workflow start target. */
export async function reserveWorkflowStart<
  TTarget extends WorkflowStartTarget,
  TClaim,
  TResult,
>(options: {
  lock: () => Promise<unknown>;
  load: () => Promise<TTarget | undefined>;
  missingMessage: string;
  prepare?: (target: TTarget) => Promise<void>;
  linked: (
    target: TTarget,
    workflowRunId: string,
  ) => Promise<TResult | undefined>;
  claim: (
    target: TTarget,
    lease: ReturnType<typeof newWorkflowStartLease>,
  ) => Promise<TClaim>;
  now?: () => Date;
}): Promise<WorkflowStartReservation<TClaim, TResult>> {
  await options.lock();
  const target = await options.load();
  if (!target) throw new Error(options.missingMessage);
  await options.prepare?.(target);

  if (target.workflowRunId) {
    const result = await options.linked(target, target.workflowRunId);
    if (result !== undefined) return { state: "linked", result };
  }

  const now = options.now?.() ?? new Date();
  if (
    target.workflowStartLeaseExpiresAt &&
    target.workflowStartLeaseExpiresAt > now
  ) {
    return {
      state: "pending",
      leaseExpiresAt: target.workflowStartLeaseExpiresAt,
    };
  }

  const lease = newWorkflowStartLease(now);
  return {
    state: "claimed",
    claim: await options.claim(target, lease),
    ...lease,
  };
}

/**
 * Establishes one externally hosted workflow from a recoverable database lease.
 *
 * The provider does not accept caller-selected run IDs, so its start cannot be
 * committed atomically with the target row. A lease lets another caller recover
 * a dead starter, while the persisted token fences a delayed older workflow
 * before it performs application work.
 */
export async function establishReservedWorkflow<TClaim, TResult>(options: {
  reserve: () => Promise<WorkflowStartReservation<TClaim, TResult>>;
  start: (claim: TClaim, startToken: string) => Promise<string>;
  link: (
    claim: TClaim,
    startToken: string,
    providerRunId: string,
  ) => Promise<boolean>;
  fail: (claim: TClaim, startToken: string, cause: unknown) => Promise<void>;
  result: (claim: TClaim, providerRunId: string) => TResult;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (;;) {
    const reservation = await options.reserve();
    if (reservation.state === "linked") return reservation.result;
    if (reservation.state === "pending") {
      const untilExpiry = reservation.leaseExpiresAt.getTime() - now();
      await sleep(Math.max(1, Math.min(untilExpiry, 250)));
      continue;
    }

    let providerRunId: string;
    try {
      providerRunId = await options.start(
        reservation.claim,
        reservation.startToken,
      );
    } catch (cause) {
      await options.fail(reservation.claim, reservation.startToken, cause);
      throw cause;
    }

    const linked = await options.link(
      reservation.claim,
      reservation.startToken,
      providerRunId,
    );
    if (linked) return options.result(reservation.claim, providerRunId);
  }
}
