import { describe, expect, it } from "vitest";
import { treeSitterLanguageFixtures } from "~/test/tree-sitter-language-fixtures";
import { highlightSource } from "./syntax-highlighting";

describe("highlightSource", () => {
  it("preserves source text and line boundaries exactly", async () => {
    const source =
      'const answer: number = 42;\nconsole.log("answer", answer);\n';
    const lines = await highlightSource(source, "typescript");

    expect(lines.map((line) => line.text).join("\n")).toBe(source);
    expect(lines).toHaveLength(3);
  });

  it("assigns semantic token classes to TypeScript", async () => {
    const [line] = await highlightSource(
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

  it("retains TypeScript highlighting throughout JSX", async () => {
    const source = [
      "export function Indicator() {",
      "  return (",
      '    <div className="panel">',
      '      <span>{true ? `Ready` : "Waiting"}</span>',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const tokens = (await highlightSource(source, "typescript")).flatMap(
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

  it("assigns semantic token classes to Python", async () => {
    const lines = await highlightSource(
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

  it("provides grammar-backed highlighting for every supported language", async () => {
    const source =
      'public record User(int Id) { // identity\n  return "ok";\n}';
    const lines = await highlightSource(source, "java");

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

  it("distinguishes preprocessor directives and decrement from comments", async () => {
    const tokens = (
      await highlightSource("#include <vector>\n--count;", "cpp")
    ).flatMap(({ tokens: lineTokens }) => lineTokens);

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "#include",
          className: "tok-meta",
        }),
        expect.objectContaining({ text: "--", className: "tok-operator" }),
      ]),
    );
    expect(tokens.some(({ className }) => className === "tok-comment")).toBe(
      false,
    );
  });

  it("assigns grammar-backed keyword classes to SQL", async () => {
    const tokens = (
      await highlightSource(
        "CREATE INDEX `BattleAction_updatedAt_battleId_idx` ON `BattleAction` (`updatedAt`,`battleId`);",
        "sql",
      )
    ).flatMap(({ tokens: lineTokens }) => lineTokens);

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "CREATE", className: "tok-keyword" }),
        expect.objectContaining({ text: "INDEX", className: "tok-keyword" }),
        expect.objectContaining({ text: "ON", className: "tok-keyword" }),
      ]),
    );
  });

  it.each(Object.entries(treeSitterLanguageFixtures))(
    "highlights %s through its browser grammar",
    async (language, fixture) => {
      const lines = await highlightSource(fixture.source, language);
      expect(lines.map(({ text }) => text).join("\n")).toBe(fixture.source);
      expect(lines.flatMap(({ tokens }) => tokens).length).toBeGreaterThan(0);
    },
    // Each case compiles a grammar's WebAssembly. That is milliseconds on an
    // idle machine and far more on a shared runner compiling sixty-two of them
    // beside every other suite, which the default five seconds does not cover.
    30_000,
  );
});
