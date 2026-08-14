import { describe, expect, it } from "vitest";
import {
  definitionIsWhereTheNameWasRead,
  isPeekableToken,
  peekPlacement,
} from "./symbol-peek";

describe("a definition worth showing", () => {
  const definition = {
    endLine: 202,
    path: "src/server/providers/types.ts",
    startLine: 190,
  };

  it.each([190, 197, 202])(
    "says nothing about a name read from its own declaration at line %i",
    (line) => {
      expect(
        definitionIsWhereTheNameWasRead(definition, {
          line,
          path: definition.path,
        }),
      ).toBe(true);
    },
  );

  it("shows a declaration the reader is somewhere else in the file from", () => {
    expect(
      definitionIsWhereTheNameWasRead(definition, {
        line: 900,
        path: definition.path,
      }),
    ).toBe(false);
    expect(
      definitionIsWhereTheNameWasRead(definition, {
        line: 189,
        path: definition.path,
      }),
    ).toBe(false);
  });

  it("shows a declaration that lives in another file", () => {
    expect(
      definitionIsWhereTheNameWasRead(definition, {
        line: 197,
        path: "src/server/providers/github.ts",
      }),
    ).toBe(false);
  });

  it("shows a declaration when the reading line is unknown", () => {
    expect(
      definitionIsWhereTheNameWasRead(definition, { path: definition.path }),
    ).toBe(false);
  });
});

describe("peekable tokens", () => {
  it.each([
    ["tok-function", "retryRequest"],
    ["tok-typeName", "RetryPolicy"],
    ["tok-variableName", "retries"],
    ["", "helper"],
    ["tok-variableName tok-local", "scoped"],
  ])("looks up a %s token named %s", (className, text) => {
    expect(isPeekableToken({ className, text })).toBe(true);
  });

  it.each([
    ["tok-keyword", "const"],
    ["tok-typeName", "string"],
    ["tok-string", "retryRequest"],
    ["tok-comment", "retryRequest"],
    ["tok-number", "42"],
    ["tok-operator", "=>"],
    ["", "3"],
    ["", "  "],
    ["", "user.name"],
  ])("leaves a %s token holding %s alone", (className, text) => {
    expect(isPeekableToken({ className, text })).toBe(false);
  });

  it("treats a keyword as a keyword whatever its casing", () => {
    expect(isPeekableToken({ className: "", text: "Class" })).toBe(false);
  });
});

describe("definition card placement", () => {
  const viewport = { height: 900, width: 1400 };

  it("sits under the name when there is room", () => {
    const placement = peekPlacement(
      { bottom: 300, left: 200, top: 284 },
      viewport,
    );

    expect(placement.placement).toBe("below");
    expect(placement.top).toBe(306);
    expect(placement.left).toBe(200);
  });

  it("flips above a name near the bottom of the viewport", () => {
    const placement = peekPlacement(
      { bottom: 880, left: 200, top: 864 },
      viewport,
    );

    expect(placement.placement).toBe("above");
    expect(placement.top).toBe(858);
  });

  it("keeps a card anchored to the right edge inside the viewport", () => {
    const placement = peekPlacement(
      { bottom: 300, left: 1380, top: 284 },
      viewport,
    );

    expect(placement.left).toBe(1400 - 460 - 12);
  });

  it("never places a card off the left edge of a narrow viewport", () => {
    const placement = peekPlacement(
      { bottom: 300, left: 4, top: 284 },
      { height: 900, width: 380 },
    );

    expect(placement.left).toBe(12);
  });

  it("gives the card the taller side when neither side is roomy", () => {
    const placement = peekPlacement(
      { bottom: 250, left: 10, top: 234 },
      { height: 300, width: 1400 },
    );

    expect(placement.placement).toBe("above");
    expect(placement.maxHeight).toBe(222);
  });

  it("never claims more height than the side it was placed on has", () => {
    // A short viewport with the name near its middle leaves neither side the
    // card's preferred height; it has to scroll rather than overflow.
    const placement = peekPlacement(
      { bottom: 110, left: 10, top: 94 },
      { height: 200, width: 1400 },
    );

    expect(placement.maxHeight).toBeLessThanOrEqual(200);
    expect(placement.maxHeight).toBe(
      placement.placement === "below" ? 200 - 110 - 12 : 94 - 12,
    );
  });

  it("gives a card no room at all rather than a negative height", () => {
    const placement = peekPlacement(
      { bottom: 210, left: 10, top: 198 },
      { height: 200, width: 1400 },
    );

    expect(placement.maxHeight).toBeGreaterThanOrEqual(0);
  });
});
