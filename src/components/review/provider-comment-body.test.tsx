// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import mermaid from "mermaid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCommentBody } from "./provider-comment-body";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>A to B</text></svg>',
    })),
  },
}));

afterEach(cleanup);

describe("ProviderCommentBody", () => {
  it("renders GitHub-flavored Markdown and allowlisted HTML", () => {
    render(
      <ProviderCommentBody
        body={[
          "**Shared Redis bucket** with `ratelimitMiddleware`.",
          "",
          "<details><summary>Prompt to fix</summary>",
          "",
          "- Inspect the shared key",
          "- Keep the fix concise",
          "",
          "</details>",
        ].join("\n")}
      />,
    );

    expect(
      screen.getByText("Shared Redis bucket", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ratelimitMiddleware", { selector: "code" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Prompt to fix").closest("summary")).not.toBeNull();
    expect(screen.getByText("Inspect the shared key")).toBeInTheDocument();
  });

  it("removes executable HTML, event handlers, and unsafe URLs", () => {
    const { container } = render(
      <ProviderCommentBody
        body={[
          '<script>alert("unsafe")</script>',
          '<a href="javascript:alert(1)">unsafe link</a>',
          '<img src="https://example.com/badge.svg" onerror="alert(1)" alt="badge">',
          '<iframe src="https://example.com"></iframe>',
        ].join("\n")}
      />,
    );

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.getByText("unsafe link").closest("a")).toBeNull();
    const imagePlaceholder = screen.getByRole("img", { name: "badge" });
    expect(imagePlaceholder).toHaveTextContent("badge");
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("https://example.com/badge.svg");
  });

  it("renders a Mermaid fence as a diagram instead of a source listing", async () => {
    render(
      <ProviderCommentBody
        variant="document"
        body={["```mermaid", "flowchart LR", "A --> B", "```"].join("\n")}
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeVisible();
    expect(screen.queryByText("flowchart LR", { selector: "code" })).toBeNull();
  });

  it("keeps the Mermaid source visible when drawing fails", async () => {
    vi.mocked(mermaid.parse).mockRejectedValueOnce(
      new Error("Parse error on line 1"),
    );

    render(
      <ProviderCommentBody
        variant="document"
        body={["```mermaid", "flowchart LR", "A --> B", "```"].join("\n")}
      />,
    );

    expect(await screen.findByText("Parse error on line 1")).toBeVisible();
    expect(screen.getByText(/flowchart LR/)).toBeVisible();
    expect(screen.getByText(/A --> B/)).toBeVisible();
    expect(
      screen.queryByRole("img", { name: "Mermaid diagram" }),
    ).not.toBeInTheDocument();
  });

  it("renders remote priority images as local badges", () => {
    render(
      <ProviderCommentBody body='<img alt="P2" src="https://untrusted.example/badge.svg">' />,
    );

    expect(screen.getByRole("img", { name: "P2" })).toHaveTextContent("P2");
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });
});
