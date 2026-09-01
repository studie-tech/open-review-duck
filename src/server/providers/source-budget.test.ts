import { describe, expect, it, vi } from "vitest";
import { collectProviderSourceFiles, loadChangedSource } from "./source-budget";

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

describe("loadChangedSource", () => {
  it("skips fetching when the path is a known binary", async () => {
    const getFileContent = vi.fn();

    await expect(
      loadChangedSource({
        path: "assets/logo.png",
        ref: "head",
        previousRef: "base",
        changeType: "modified",
        needsPrevious: true,
        oversizedHash: "sha-png",
        getFileContent,
      }),
    ).resolves.toEqual({
      file: {
        path: "assets/logo.png",
        content: "",
        isBinary: true,
        binaryHash: "sha-png",
        changeType: "modified",
      },
    });
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it("skips as too_large when the current or previous revision is missing", async () => {
    await expect(
      loadChangedSource({
        path: "src/missing.ts",
        ref: "head",
        previousRef: "base",
        changeType: "modified",
        needsPrevious: false,
        oversizedHash: "sha-missing",
        getFileContent: async () => undefined,
      }),
    ).resolves.toEqual({
      file: {
        path: "src/missing.ts",
        content: "",
        skipReason: "too_large",
        isBinary: false,
        binaryHash: "sha-missing",
        changeType: "modified",
      },
    });

    await expect(
      loadChangedSource({
        path: "src/partial.ts",
        ref: "head",
        previousRef: "base",
        changeType: "modified",
        needsPrevious: true,
        oversizedHash: "sha-partial",
        getFileContent: async (_path, ref) =>
          ref === "head" ? "after" : undefined,
      }),
    ).resolves.toEqual({
      file: {
        path: "src/partial.ts",
        content: "",
        skipReason: "too_large",
        isBinary: false,
        binaryHash: "sha-partial",
        changeType: "modified",
      },
    });
  });

  it("uses fetch paths and content-sniffed binary hashes from the adapter", async () => {
    const getFileContent = vi.fn(async (path: string) => {
      expect(path).toBe("/src/blob.dat");
      return "header\0payload";
    });

    await expect(
      loadChangedSource({
        path: "src/blob.dat",
        fetchPath: "/src/blob.dat",
        ref: "head",
        previousRef: "base",
        changeType: "modified",
        needsPrevious: true,
        oversizedHash: "head:src/blob.dat",
        contentBinaryHash: (content) => `head:src/blob.dat:${content.length}`,
        getFileContent,
      }),
    ).resolves.toEqual({
      file: {
        path: "src/blob.dat",
        content: "",
        isBinary: true,
        binaryHash: "head:src/blob.dat:14",
        changeType: "modified",
      },
    });
    expect(getFileContent).toHaveBeenCalledTimes(1);
  });

  it("loads current and previous source when both revisions exist", async () => {
    const getFileContent = vi.fn(async (path: string, ref: string) => {
      if (path === "src/old.ts" && ref === "base") return "before";
      if (path === "src/new.ts" && ref === "head") return "after";
      return undefined;
    });

    await expect(
      loadChangedSource({
        path: "src/new.ts",
        previousFetchPath: "src/old.ts",
        ref: "head",
        previousRef: "base",
        changeType: "renamed",
        needsPrevious: true,
        oversizedHash: "head:src/new.ts",
        getFileContent,
      }),
    ).resolves.toEqual({
      file: {
        path: "src/new.ts",
        content: "after",
        previousContent: "before",
        isBinary: false,
        changeType: "renamed",
      },
      oversizedHash: "head:src/new.ts",
    });
    expect(getFileContent).toHaveBeenCalledTimes(2);
  });
});
