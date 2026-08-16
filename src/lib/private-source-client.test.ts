import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hydratePrivateReviewSources,
  prioritizePrivateReviewSources,
} from "./private-source-client";

afterEach(() => vi.unstubAllGlobals());

describe("hydratePrivateReviewSources", () => {
  it("prefetches the visible concept before the remaining review path", () => {
    const sources = [
      { id: "later", path: "src/later.ts" },
      { id: "related", path: "src/related.ts" },
      { id: "active", path: "src/active.ts" },
      { id: "same-file", path: "src/active.ts" },
      { id: "other-related-file", path: "src/related.ts" },
    ];

    expect(
      prioritizePrivateReviewSources(sources, {
        activeId: "active",
        activePath: "src/active.ts",
        relatedIds: new Set(["active", "related"]),
        relatedPaths: new Set(["src/active.ts", "src/related.ts"]),
      }).map(({ id }) => id),
    ).toEqual([
      "active",
      "related",
      "same-file",
      "other-related-file",
      "later",
    ]);
  });

  it("keeps successfully hydrated files when another private object fails", async () => {
    const source = "export const ready = true;\n";
    const digest = createHash("sha256").update(source).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("failed-blob")) {
          return new Response(null, { status: 503 });
        }
        if (url.startsWith("/api/source/")) {
          return Response.json({
            digest,
            signedUrl: "https://private.example/source",
          });
        }
        return new Response(source);
      }),
    );
    const base = {
      previousBlobId: null,
      previousStartByte: null,
      previousEndByte: null,
      startByte: 0,
      endByte: Buffer.byteLength(source),
    };
    const result = await hydratePrivateReviewSources(
      [
        { ...base, currentBlobId: "ready-blob", path: "src/ready.ts" },
        {
          ...base,
          currentBlobId: "failed-blob",
          path: "src/unavailable.ts",
        },
      ],
      "snapshot",
      new Map(),
      1,
    );

    expect(result.units[0]).toMatchObject({ source });
    expect(result.units[1]).not.toHaveProperty("source");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe("src/unavailable.ts");
    expect(result.successfulIndexes).toEqual([0]);
  });

  it("publishes successful units incrementally and forwards cancellation", async () => {
    const source = "ready\n";
    const digest = createHash("sha256").update(source).digest("hex");
    const controller = new AbortController();
    const hydrated = vi.fn();
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) =>
        String(input).startsWith("/api/source/")
          ? Response.json({
              digest,
              signedUrl: "https://private.example/source",
            })
          : new Response(source),
    );
    vi.stubGlobal("fetch", fetchMock);

    await hydratePrivateReviewSources(
      [
        {
          currentBlobId: "blob",
          previousBlobId: null,
          startByte: 0,
          endByte: Buffer.byteLength(source),
          previousStartByte: null,
          previousEndByte: null,
          path: "src/ready.ts",
        },
      ],
      "snapshot",
      new Map(),
      1,
      controller.signal,
      hydrated,
    );

    expect(hydrated).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ source }),
    );
    const authorizationSignal = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/source/"),
    )?.[1]?.signal;
    const downloadSignal = fetchMock.mock.calls.find(
      ([url]) => String(url) === "https://private.example/source",
    )?.[1]?.signal;
    expect(authorizationSignal).toBeInstanceOf(AbortSignal);
    expect(downloadSignal).toBeInstanceOf(AbortSignal);
    expect(authorizationSignal?.aborted).toBe(false);
    expect(downloadSignal?.aborted).toBe(false);
    controller.abort();
    expect(authorizationSignal?.aborted).toBe(true);
    expect(downloadSignal?.aborted).toBe(true);
  });
});
