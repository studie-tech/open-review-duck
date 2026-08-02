import { describe, expect, it } from "vitest";
import {
  isLikelyBinaryFile,
  isSupportedSourcePath,
  supportedLanguages,
} from "./types";

describe("analysis source classification", () => {
  it("recognizes extension-based and conventional language filenames", () => {
    expect(isSupportedSourcePath("src/Main.java")).toBe(true);
    expect(isSupportedSourcePath("build/Makefile")).toBe(true);
    expect(isSupportedSourcePath("scripts/.zshrc")).toBe(true);
    expect(isSupportedSourcePath("infra/main.tf")).toBe(true);
    expect(isSupportedSourcePath("config/settings.json")).toBe(true);
    expect(isSupportedSourcePath("notes.unknown")).toBe(false);
    expect(supportedLanguages).toContain("text");
  });

  it("detects known and content-derived binary files conservatively", () => {
    expect(isLikelyBinaryFile("assets/logo.png")).toBe(true);
    expect(isLikelyBinaryFile("unknown.data", "header\0payload")).toBe(true);
    expect(isLikelyBinaryFile("notes.txt", "hello\nworld\n")).toBe(false);
    expect(isLikelyBinaryFile("locales.txt", "smørrebrød 日本語")).toBe(false);
  });
});
