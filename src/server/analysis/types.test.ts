import { describe, expect, it } from "vitest";
import { isLikelyBinaryFile } from "./types";

describe("analysis source classification", () => {
  it("detects known and content-derived binary files conservatively", () => {
    expect(isLikelyBinaryFile("assets/logo.png")).toBe(true);
    expect(isLikelyBinaryFile("unknown.data", "header\0payload")).toBe(true);
    expect(isLikelyBinaryFile("notes.txt", "hello\nworld\n")).toBe(false);
    expect(isLikelyBinaryFile("locales.txt", "smørrebrød 日本語")).toBe(false);
  });
});
