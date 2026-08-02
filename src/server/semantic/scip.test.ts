import { describe, expect, it } from "vitest";
import { parseScipIndex, searchScipIndex } from "./scip";

/** Encodes one non-negative protobuf varint for compact fixtures. */
function varint(value: number) {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(next | (value > 0 ? 0x80 : 0));
  } while (value > 0);
  return bytes;
}

/** Encodes a length-delimited protobuf field. */
function value(field: number, bytes: number[] | Uint8Array) {
  return [field * 8 + 2, ...varint(bytes.length), ...bytes];
}

/** Encodes a UTF-8 protobuf string field. */
function string(field: number, text: string) {
  return value(field, new TextEncoder().encode(text));
}

/** Creates an occurrence using SCIP's packed legacy range representation. */
function occurrence(symbol: string, roles: number, range: number[]) {
  return [
    ...value(1, range.flatMap(varint)),
    ...string(2, symbol),
    3 * 8,
    ...varint(roles),
  ];
}

/** Creates one minimal valid SCIP index fixture. */
function index(path = "src/task.ts") {
  const document = [
    ...string(1, path),
    ...value(2, occurrence("npm pkg 1 Task#run().", 1, [3, 2, 5])),
    ...value(2, occurrence("npm pkg 1 Task#run().", 8, [7, 4, 7, 8])),
  ];
  return Uint8Array.from(value(2, document));
}

describe("SCIP protobuf ingestion", () => {
  it("validates documents and exposes exact definition/reference ranges", () => {
    const parsed = parseScipIndex(index());
    expect(parsed).toMatchObject({ documentCount: 1, occurrenceCount: 2 });
    expect(searchScipIndex(parsed, "Task#run")).toEqual([
      {
        path: "src/task.ts",
        line: 4,
        character: 3,
        endLine: 4,
        endCharacter: 6,
        symbol: "npm pkg 1 Task#run().",
        role: "definition",
      },
      {
        path: "src/task.ts",
        line: 8,
        character: 5,
        endLine: 8,
        endCharacter: 9,
        symbol: "npm pkg 1 Task#run().",
        role: "reference",
      },
    ]);
  });

  it("rejects unsafe paths and malformed protobuf", () => {
    expect(() => parseScipIndex(index("../secret.ts"))).toThrow("unsafe");
    expect(() => parseScipIndex(Uint8Array.from([18, 20, 1]))).toThrow(
      "Truncated",
    );
  });
});
