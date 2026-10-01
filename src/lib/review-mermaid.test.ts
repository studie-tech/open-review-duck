import { describe, expect, it } from "vitest";
import { isMermaidSource, prepareMermaidSource } from "./review-mermaid";

describe("isMermaidSource", () => {
  it("accepts an explicit Mermaid fence", () => {
    expect(isMermaidSource("mermaid", "flowchart LR\nA --> B")).toBe(true);
    expect(isMermaidSource("mmd", "classDiagram\nClass01 <|-- Class02")).toBe(
      true,
    );
  });

  it("accepts an unlabeled flowchart or UML diagram", () => {
    expect(isMermaidSource(undefined, "flowchart LR\nA --> B")).toBe(true);
    expect(isMermaidSource("text", "sequenceDiagram\nA->>B: hello")).toBe(true);
    expect(isMermaidSource(undefined, "classDiagram\nFoo <|-- Bar")).toBe(true);
    expect(isMermaidSource(undefined, "zenuml\nA.method()")).toBe(true);
  });

  it("leaves ordinary source fences alone", () => {
    expect(isMermaidSource("ts", "flowchart LR\nA --> B")).toBe(false);
    expect(isMermaidSource("bash", "graph LR")).toBe(false);
    expect(isMermaidSource(undefined, "console.log('flowchart')")).toBe(false);
    expect(isMermaidSource("mermaid", "   ")).toBe(false);
  });
});

describe("prepareMermaidSource", () => {
  it("renames a reserved flowchart node so Mermaid can parse it", () => {
    expect(
      prepareMermaidSource(
        [
          "flowchart LR",
          '  output --> graph["Canonical tables"]',
          "  graph --> history",
        ].join("\n"),
      ),
    ).toBe(
      [
        "flowchart LR",
        '  output --> n_graph["Canonical tables"]',
        "  n_graph --> history",
      ].join("\n"),
    );
  });

  it("renames a reserved node at the end of an edge", () => {
    expect(prepareMermaidSource("flowchart LR\n  Start --> end")).toBe(
      "flowchart LR\n  Start --> n_end",
    );
  });

  it("leaves class and sequence diagrams unchanged", () => {
    const sequence = "sequenceDiagram\nAlice->>Bob: graph";
    expect(prepareMermaidSource(sequence)).toBe(sequence);
  });
});
