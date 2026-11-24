import { describe, expect, it } from "vitest";
import {
  canParseClientSource,
  canTokenizeClientSource,
  MAX_CLIENT_PARSE_LENGTH,
  MAX_CLIENT_SOURCE_LINE_LENGTH,
  MAX_CLIENT_TOKENIZE_LENGTH,
} from "./source-processing-budget";

describe("browser source processing budgets", () => {
  it("limits parsing separately from the cheaper lexical scan", () => {
    const source = "SELECT 1;\n".repeat(10_000);
    expect(source.length).toBeGreaterThan(MAX_CLIENT_PARSE_LENGTH);
    expect(canParseClientSource(source)).toBe(false);
    expect(canTokenizeClientSource(source)).toBe(true);
    const dump = "SELECT 1;\n".repeat(MAX_CLIENT_TOKENIZE_LENGTH);
    expect(canParseClientSource(dump)).toBe(false);
    expect(canTokenizeClientSource(dump)).toBe(false);
  });

  it("rejects long generated lines even inside a small file", () => {
    const line = "x".repeat(MAX_CLIENT_SOURCE_LINE_LENGTH);
    expect(canParseClientSource(`${line}\n${line}`)).toBe(true);
    expect(canTokenizeClientSource(`${line}\n${line}`)).toBe(true);
    expect(canParseClientSource(`${line}x`)).toBe(false);
    expect(canTokenizeClientSource(`short\n${line}x\nshort`)).toBe(false);
  });
});
