import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydratePrivateReviewSources } from "./private-source-client";

afterEach(() => vi.unstubAllGlobals());

describe("hydratePrivateReviewSources", () => {
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
});
