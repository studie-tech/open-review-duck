import { describe, expect, it } from "vitest";
import {
  createSignOffQueue,
  nextSignOffBatchSize,
  reviewFooterSaveState,
  signOffQueueReducer,
} from "./sign-off-queue";

describe("sign-off save queue", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [20, 20],
    [21, 20],
    [100, 20],
  ])("takes %i queued saves as a batch of %i", (pending, expected) => {
    expect(nextSignOffBatchSize(pending)).toBe(expected);
  });

  it("reports completed work against an expanding batch total", () => {
    let state = createSignOffQueue();
    state = signOffQueueReducer(state, { type: "enqueue", unitId: "one" });
    state = signOffQueueReducer(state, { type: "enqueue", unitId: "two" });
    state = signOffQueueReducer(state, { type: "settle", unitId: "one" });
    state = signOffQueueReducer(state, { type: "enqueue", unitId: "three" });

    expect(state.completed).toBe(1);
    expect(state.total).toBe(3);
    expect([...state.ids]).toEqual(["two", "three"]);
  });

  it("starts a fresh progress total after the previous queue drains", () => {
    let state = createSignOffQueue();
    state = signOffQueueReducer(state, { type: "enqueue", unitId: "one" });
    state = signOffQueueReducer(state, { type: "settle", unitId: "one" });
    state = signOffQueueReducer(state, { type: "enqueue", unitId: "two" });

    expect(state.completed).toBe(0);
    expect(state.total).toBe(1);
    expect([...state.ids]).toEqual(["two"]);
  });

  it("does not count duplicate queue events", () => {
    const queued = signOffQueueReducer(createSignOffQueue(), {
      type: "enqueue",
      unitId: "one",
    });

    expect(
      signOffQueueReducer(queued, { type: "enqueue", unitId: "one" }),
    ).toBe(queued);
    expect(
      signOffQueueReducer(queued, { type: "settle", unitId: "missing" }),
    ).toBe(queued);
  });

  it("reconnects to pending mutations and follows them across remounts", () => {
    let state = signOffQueueReducer(createSignOffQueue(), {
      type: "synchronize",
      unitIds: ["one", "two", "three"],
    });
    state = signOffQueueReducer(state, {
      type: "synchronize",
      unitIds: ["two", "three", "four"],
    });

    expect(state.completed).toBe(1);
    expect(state.total).toBe(4);
    expect([...state.ids]).toEqual(["two", "three", "four"]);
  });

  it.each([
    [0, false, false, "idle"],
    [3, false, false, "background"],
    [3, true, false, "active"],
    [3, false, true, "finalizing"],
    [3, true, true, "finalizing"],
  ] as const)(
    "uses one footer state for %i pending saves (active: %s, complete: %s)",
    (pendingSaveCount, activeSavePending, reviewComplete, expected) => {
      expect(
        reviewFooterSaveState({
          activeSavePending,
          pendingSaveCount,
          reviewComplete,
        }),
      ).toBe(expected);
    },
  );
});
