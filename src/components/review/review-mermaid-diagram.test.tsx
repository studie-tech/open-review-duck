// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import mermaid from "mermaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewMermaidDiagram } from "./review-mermaid-diagram";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>',
    })),
  },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ReviewMermaidDiagram", () => {
  it.each([
    'flowchart LR\nA@{ img: "https://tracker.example/token.png", label: "Status" }',
    'flowchart LR\nA["<img src=https://tracker.example/token.png>"]',
    '---\nconfig:\n  themeCSS: "svg { background: url(https://tracker.example/token.png) }"\n---\nflowchart LR\nA --> B',
  ])(
    "never passes resource-bearing source to Mermaid before consent: %s",
    (chart) => {
      render(<ReviewMermaidDiagram chart={chart} />);

      expect(
        screen.getByText(chart, { normalizer: (text) => text }),
      ).toBeVisible();
      expect(
        screen.getByText("Rendering may load external images."),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Render diagram" }),
      ).toBeVisible();
      expect(mermaid.initialize).not.toHaveBeenCalled();
      expect(mermaid.parse).not.toHaveBeenCalled();
      expect(mermaid.render).not.toHaveBeenCalled();
    },
  );

  it("draws a diagram after an explicit choice and requires consent for edited source", async () => {
    const original = "flowchart LR\nA --> B";
    const replacement =
      'flowchart LR\nA@{ img: "https://tracker.example/new.png" }';
    const { rerender } = render(<ReviewMermaidDiagram chart={original} />);
    fireEvent.click(screen.getByRole("button", { name: "Render diagram" }));
    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeVisible();
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), original);

    rerender(<ReviewMermaidDiagram chart={replacement} />);
    expect(
      screen.getByRole("button", { name: "Render diagram" }),
    ).toBeVisible();
    expect(
      screen.getByText(replacement, { normalizer: (text) => text }),
    ).toBeVisible();
    expect(screen.queryByRole("img", { name: "Mermaid diagram" })).toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Render diagram" }));
    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeVisible();
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.any(String),
      replacement,
    );
  });
});
