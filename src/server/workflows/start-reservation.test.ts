import { describe, expect, it, vi } from "vitest";
import {
  establishReservedWorkflow,
  reserveWorkflowStart,
  type WorkflowStartReservation,
} from "./start-reservation";

type Claim = { targetId: string };
type Result = { targetId: string; workflowRunId: string };

/** Builds the public result returned after a durable link is established. */
function result(claim: Claim, workflowRunId: string): Result {
  return { targetId: claim.targetId, workflowRunId };
}

describe("recoverable workflow starts", () => {
  it("reclaims a reservation after its starter disappears", async () => {
    const claim = { targetId: "target-1" };
    const target = {
      workflowRunId: null,
      workflowStartLeaseExpiresAt: new Date(100),
    };
    const start = vi.fn(async () => "run-replacement");

    await expect(
      establishReservedWorkflow({
        reserve: () =>
          reserveWorkflowStart({
            lock: async () => undefined,
            load: async () => target,
            missingMessage: "Target not found",
            linked: async () => undefined,
            claim: async () => claim,
            now: () => new Date(100),
          }),
        start,
        link: async () => true,
        fail: async () => undefined,
        result,
        now: () => 100,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({
      targetId: claim.targetId,
      workflowRunId: "run-replacement",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(claim, expect.any(String));
  });

  it("lets concurrent callers share one in-flight start", async () => {
    const claim = { targetId: "target-2" };
    let linked: Result | undefined;
    let claimed = false;
    let releaseWaiters: (() => void) | undefined;
    const linkedSignal = new Promise<void>((resolve) => {
      releaseWaiters = resolve;
    });
    const reserve = vi.fn(
      async (): Promise<WorkflowStartReservation<Claim, Result>> => {
        if (linked) return { state: "linked", result: linked };
        if (claimed) {
          return {
            state: "pending",
            leaseExpiresAt: new Date(Date.now() + 1000),
          };
        }
        claimed = true;
        return {
          state: "claimed",
          claim,
          startToken: "sole-token",
          leaseExpiresAt: new Date(Date.now() + 1000),
        };
      },
    );
    const start = vi.fn(async () => "run-sole");
    const options = {
      reserve,
      start,
      link: async () => {
        linked = result(claim, "run-sole");
        releaseWaiters?.();
        return true;
      },
      fail: async () => undefined,
      result,
      sleep: async () => linkedSignal,
    };

    const starts = await Promise.all([
      establishReservedWorkflow(options),
      establishReservedWorkflow(options),
    ]);

    expect(starts).toEqual([linked, linked]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("reuses an established link without starting another provider run", async () => {
    const established = { targetId: "target-3", workflowRunId: "run-existing" };
    const start = vi.fn(async () => "run-new");

    await expect(
      establishReservedWorkflow({
        reserve: async () => ({ state: "linked", result: established }),
        start,
        link: async () => true,
        fail: async () => undefined,
        result,
      }),
    ).resolves.toEqual(established);
    expect(start).not.toHaveBeenCalled();
  });

  it("records an ordinary provider start failure for the owning token", async () => {
    const failure = new Error("provider unavailable");
    const claim = { targetId: "target-4" };
    const fail = vi.fn(async () => undefined);

    await expect(
      establishReservedWorkflow({
        reserve: async () => ({
          state: "claimed",
          claim,
          startToken: "failed-token",
          leaseExpiresAt: new Date(Date.now() + 1000),
        }),
        start: async () => {
          throw failure;
        },
        link: async () => true,
        fail,
        result,
      }),
    ).rejects.toBe(failure);
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(claim, "failed-token", failure);
  });
});
