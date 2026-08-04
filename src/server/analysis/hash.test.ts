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

  it("retains Python block structure across indentation-only changes", () => {
    expect(
      semanticSource("if user.is_admin:\n    audit(user)\n", "python"),
    ).not.toBe(
      semanticSource("if user.is_admin:\n    pass\naudit(user)\n", "python"),
    );
  });

  it("retains TypeScript automatic-semicolon-insertion structure", () => {
    expect(
      semanticSource(
        "function value() { return { debug: true }; }",
        "typescript",
      ),
    ).not.toBe(
      semanticSource(
        "function value() { return\n{ debug: true }; }",
        "typescript",
      ),
    );
  });
});
