import { describe, expect, it } from "vitest";
import { highlightSource } from "./syntax-highlighting";

describe("highlightSource", () => {
  it("preserves source text and line boundaries exactly", () => {
    const source =
      'const answer: number = 42;\nconsole.log("answer", answer);\n';
    const lines = highlightSource(source, "typescript");

    expect(lines.map((line) => line.text).join("\n")).toBe(source);
    expect(lines).toHaveLength(3);
  });

  it("assigns semantic token classes to TypeScript", () => {
    const [line] = highlightSource(
      "const answer: number = 42; // meaning",
      "typescript",
    );

    expect(line?.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "const", className: "tok-keyword" }),
        expect.objectContaining({ text: "number", className: "tok-typeName" }),
        expect.objectContaining({ text: "42", className: "tok-number" }),
        expect.objectContaining({
          text: "// meaning",
          className: "tok-comment",
        }),
      ]),
    );
  });

  it("retains TypeScript highlighting throughout JSX", () => {
    const source = [
      "export function Indicator() {",
      "  return (",
      '    <div className="panel">',
      '      <span>{true ? `Ready` : "Waiting"}</span>',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const tokens = highlightSource(source, "typescript").flatMap(
      (line) => line.tokens,
    );

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "export", className: "tok-keyword" }),
        expect.objectContaining({ text: "function", className: "tok-keyword" }),
        expect.objectContaining({ text: "true", className: "tok-bool" }),
        expect.objectContaining({
          text: '"Waiting"',
          className: "tok-string",
        }),
      ]),
    );
  });

  it("assigns semantic token classes to Python", () => {
    const lines = highlightSource(
      'def greet(name: str):\n    return f"Hello {name}"',
      "python",
    );
    const tokens = lines.flatMap((line) => line.tokens);

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "def", className: "tok-keyword" }),
        expect.objectContaining({ text: "return", className: "tok-keyword" }),
        expect.objectContaining({ className: "tok-string2" }),
      ]),
    );
  });

  it("provides safe generic highlighting for newly supported languages", () => {
    const source =
      'public record User(int Id) { // identity\n  return "ok";\n}';
    const lines = highlightSource(source, "java");

    expect(lines.map(({ text }) => text).join("\n")).toBe(source);
    expect(lines.flatMap(({ tokens }) => tokens)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "public", className: "tok-keyword" }),
        expect.objectContaining({ text: "User", className: "tok-typeName" }),
        expect.objectContaining({
          text: "// identity",
          className: "tok-comment",
        }),
      ]),
    );
    expect(lines[1]?.tokens[0]?.from).toBeGreaterThan(source.indexOf("\n"));
  });

  it("distinguishes preprocessor directives and decrement from comments", () => {
    const tokens = highlightSource(
      "#include <vector>\n--count;",
      "cpp",
    ).flatMap(({ tokens: lineTokens }) => lineTokens);

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "#include <vector>",
          className: "tok-meta",
        }),
        expect.objectContaining({ text: "--", className: "tok-operator" }),
      ]),
    );
    expect(tokens.some(({ className }) => className === "tok-comment")).toBe(
      false,
    );
  });
});
