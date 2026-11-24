// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lexicalLines } from "./lexical-highlighting";
import { MAX_CLIENT_TOKENIZE_LENGTH } from "./source-processing-budget";
import { useHighlightedSource } from "./syntax-highlighting";

vi.mock("./lexical-highlighting", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lexical-highlighting")>();
  return { ...actual, lexicalLines: vi.fn(actual.lexicalLines) };
});

afterEach(() => {
  cleanup();
  vi.mocked(lexicalLines).mockClear();
});

/** Reports the line count the hook highlighted for a source. */
function HighlightHarness({ source }: { source: string }) {
  const lines = useHighlightedSource(source, "typescript");
  return <output>{lines.length}</output>;
}

describe("useHighlightedSource", () => {
  it("does not tokenize a large SQL dump during render or the effect", () => {
    const source = "INSERT INTO assets VALUES (1, 'asset');\n".repeat(17_000);
    expect(source.length).toBeGreaterThan(MAX_CLIENT_TOKENIZE_LENGTH);
    render(<HighlightHarness source={source} />);
    expect(screen.getByRole("status")).toHaveTextContent("17001");
    expect(vi.mocked(lexicalLines)).not.toHaveBeenCalled();
  });

  it("scans a source lexically once across the render and the effect", () => {
    render(
      <HighlightHarness source={"const first = 1;\nconst second = 2;\n"} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("3");
    expect(vi.mocked(lexicalLines)).toHaveBeenCalledTimes(1);
  });

  it("shares one scan between two views of the same source", () => {
    const source = "const shared = 1;\n";
    render(
      <>
        <HighlightHarness source={source} />
        <HighlightHarness source={source} />
      </>,
    );

    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(vi.mocked(lexicalLines)).toHaveBeenCalledTimes(1);
  });
});
