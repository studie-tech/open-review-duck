import { describe, expect, it } from "vitest";
import { collectProviderSourceFiles } from "./source-budget";

/** Builds a deferred promise so a load can be resolved from the test body. */
function deferredLoad() {
  /** Stands in until the executor supplies the real resolver. */
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, release };
}

describe("provider source budget", () => {
  it("keeps several loads in flight while preserving the file order", async () => {
    const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.ts`);
    const gates = paths.map(() => deferredLoad());
    let active = 0;
    let maximumActive = 0;

    const collected = collectProviderSourceFiles(
      paths,
      undefined,
      async (path) => {
        const gate = gates[paths.indexOf(path)];
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate?.started;
        active -= 1;
        return { file: { path, content: path, isBinary: false } };
      },
    );

    await Promise.resolve();
    expect(maximumActive).toBe(8);

    for (const gate of gates) gate.release();

    await expect(collected).resolves.toEqual(
      paths.map((path) => ({ path, content: path, isBinary: false })),
    );
    expect(maximumActive).toBe(8);
  });

  it("evicts the largest sources once the byte budget is exceeded", async () => {
    const files = await collectProviderSourceFiles(
      ["small", "largest", "medium"],
      6,
      async (path) =>
        Promise.resolve({
          file: {
            path,
            content:
              path === "largest" ? "12345" : path === "medium" ? "12" : "1",
            isBinary: false,
          },
        }),
    );

    expect(files).toEqual([
      { path: "small", content: "1", isBinary: false },
      expect.objectContaining({
        path: "largest",
        content: "",
        skipReason: "too_large",
      }),
      { path: "medium", content: "12", isBinary: false },
    ]);
  });
});
