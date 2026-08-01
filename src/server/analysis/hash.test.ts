import { describe, expect, it } from "vitest";

import { semanticSource } from "./hash";

describe("semantic source hashing", () => {
  it("ignores parser-insignificant whitespace", () => {
    expect(semanticSource("const answer=42;", "typescript")).toBe(
      semanticSource("const   answer = 42 ;", "typescript"),
    );
  });

  it("retains reviewer-visible comments", () => {
    expect(
      semanticSource(
        "/** Returns the public value. */\nconst answer = 42;",
        "typescript",
      ),
    ).not.toBe(
      semanticSource(
        "/** Returns the private value. */\nconst answer = 42;",
        "typescript",
      ),
    );
  });
});
