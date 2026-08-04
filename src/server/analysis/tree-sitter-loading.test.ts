import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("production Tree-sitter grammar loading", () => {
  it("loads only requested grammars and trims the warm cache to eight", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const runtime = await import("./tree-sitter");

    expect(runtime.loadedTreeSitterLanguages()).toEqual([]);
    await runtime.prepareTreeSitterLanguages(["sql"]);
    expect(runtime.loadedTreeSitterLanguages()).toEqual(["sql"]);

    const active = [
      "sql",
      "typescript",
      "javascript",
      "python",
      "java",
      "go",
      "rust",
      "ruby",
      "c",
    ] as const;
    await runtime.withPreparedTreeSitterLanguages(active, () => {
      expect(runtime.loadedTreeSitterLanguages()).toEqual(
        expect.arrayContaining([...active]),
      );
    });
    expect(runtime.loadedTreeSitterLanguages()).toHaveLength(8);
  });

  it("does not evict a grammar leased by concurrent analysis", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const runtime = await import("./tree-sitter");
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runtime.withPreparedTreeSitterLanguages(
      ["shell"],
      async () => {
        firstStarted?.();
        await firstRelease;
        expect(runtime.loadedTreeSitterLanguages()).toContain("shell");
      },
    );
    await firstReady;

    await runtime.withPreparedTreeSitterLanguages(
      [
        "sql",
        "typescript",
        "javascript",
        "python",
        "java",
        "go",
        "rust",
        "ruby",
        "c",
      ],
      () => {
        expect(runtime.loadedTreeSitterLanguages()).toContain("shell");
      },
    );
    expect(runtime.loadedTreeSitterLanguages()).toContain("shell");
    releaseFirst?.();
    await first;
    expect(runtime.loadedTreeSitterLanguages()).toHaveLength(8);
  });
});
