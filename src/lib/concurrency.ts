export interface BoundedSemaphore {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** Creates a FIFO semaphore for independently scheduled async operations. */
export function createBoundedSemaphore(capacity: number): BoundedSemaphore {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error("Semaphore capacity must be a positive integer");
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (active >= capacity || waiting.length > 0) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await operation();
      } finally {
        const next = waiting.shift();
        if (next) {
          // The released permit belongs to this waiter before it resumes. The
          // active count stays unchanged, so a newcomer cannot take it first.
          next();
        } else {
          active -= 1;
        }
      }
    },
  };
}

/** Maps values with bounded concurrency and stable result order. */
export async function mapWithLimit<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    }),
  );
  return results;
}
