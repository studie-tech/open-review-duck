import { describe, expect, it } from "vitest";
import { createBoundedSemaphore, mapWithLimit } from "./concurrency";

/** Creates a promise whose completion a concurrency test controls. */
function controlledPromise() {
  /** Releases the pending test operation. */
  let resolvePromise: (value: void | PromiseLike<void>) => void = () =>
    undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise(undefined) };
}

describe("mapWithLimit", () => {
  it("limits concurrent operations and preserves ordering", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});

describe("createBoundedSemaphore", () => {
  it("hands a released permit to the oldest waiter without newcomer barging", async () => {
    const semaphore = createBoundedSemaphore(1);
    let active = 0;
    let maximum = 0;
    const started: string[] = [];
    const firstGate = controlledPromise();
    const secondGate = controlledPromise();
    const newcomerGate = controlledPromise();
    /** Records one operation while it owns the semaphore's only permit. */
    const hold = async (name: string, gate: Promise<void>) => {
      active += 1;
      maximum = Math.max(maximum, active);
      started.push(name);
      await gate;
      active -= 1;
    };

    const first = semaphore.run(() => hold("first", firstGate.promise));
    const second = semaphore.run(() => hold("second", secondGate.promise));
    let newcomer: Promise<void> | undefined;
    // `run` registered its continuation on firstGate already. This callback
    // therefore enters after release wakes `second` but before it can resume.
    firstGate.promise.then(() => {
      newcomer = semaphore.run(() => hold("newcomer", newcomerGate.promise));
    });

    firstGate.resolve();
    await first;
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    expect(maximum).toBe(1);

    secondGate.resolve();
    await second;
    await Promise.resolve();
    expect(started).toEqual(["first", "second", "newcomer"]);
    expect(maximum).toBe(1);

    newcomerGate.resolve();
    await newcomer;
  });

  it("releases a permit after an operation fails", async () => {
    const semaphore = createBoundedSemaphore(1);
    const failure = semaphore.run(async () => {
      throw new Error("expected failure");
    });
    const successor = semaphore.run(async () => "completed");

    await expect(failure).rejects.toThrow("expected failure");
    await expect(successor).resolves.toBe("completed");
  });

  it("rejects invalid capacities", () => {
    expect(() => createBoundedSemaphore(0)).toThrow("positive integer");
    expect(() => createBoundedSemaphore(1.5)).toThrow("positive integer");
  });
});

it("stops queued work and waits for in-flight writes before allowing a retry", async () => {
  const gate = controlledPromise();
  const started: number[] = [];
  let settled = false;
  const result = mapWithLimit([1, 2, 3, 4], 2, async (value) => {
    started.push(value);
    if (value === 1) throw new Error("provider failure");
    await gate.promise;
    return value;
  });
  const observed = result.catch((cause: unknown) => {
    settled = true;
    return cause;
  });
  await Promise.resolve();
  expect(started).toEqual([1, 2]);
  expect(settled).toBe(false);
  gate.resolve();
  expect(await observed).toEqual(new Error("provider failure"));
  expect(started).toEqual([1, 2]);
});
