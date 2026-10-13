// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("button", { name: "Render diagram" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Render diagram" }));
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

  it("previews sanitized attachments when requested and opens the original image", () => {
    const onOpenImage = vi.fn();
    const { container } = render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://example.com/review/12"
        onOpenImage={onOpenImage}
        body={
          '<img src="https://example.com/screenshot.png" onerror="alert(1)" alt="Screenshot">\n<img src="https://example.com/badge.svg" alt="P2">\n<img src="javascript:alert(1)" alt="Unsafe">'
        }
      />,
    );
    const image = screen.getByRole("img", { name: "Screenshot" });
    expect(image).toHaveAttribute("referrerPolicy", "no-referrer");
    expect(image).not.toHaveAttribute("onerror");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Enlarge image: Screenshot" }),
    );
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "https://example.com/screenshot.png",
      alt: "Screenshot",
    });
  });

  it("provides an original-image link when the provider blocks an attachment preview", () => {
    render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://example.com/review/12"
        body="![Screenshot](https://example.com/private.png)"
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Screenshot" }));
    expect(screen.getByText("Screenshot · Preview unavailable")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open image" })).toHaveAttribute(
      "href",
      "https://example.com/private.png",
    );
  });

  it("resolves native GitLab uploads and reference images against the provider", () => {
    render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://gitlab.example/team/project/-/merge_requests/12"
        body={"![Screenshot][upload]\n\n[upload]: /uploads/abc/screenshot.png"}
      />,
    );
    expect(screen.getByRole("img", { name: "Screenshot" })).toHaveAttribute(
      "src",
      "https://gitlab.example/team/project/uploads/abc/screenshot.png",
    );
  });

  it("does not fetch unsafe or credential-bearing attachments in preview mode", () => {
    const { container } = render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://github.com/acme/review/pull/12"
        body={
          '<img src="javascript:alert(1)" alt="Unsafe">\n<img src="https://user:password@example.com/image.png" alt="Credential">'
        }
      />,
    );
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  it("waits for an explicit click before loading an external HTTPS image", () => {
    const { container } = render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://github.com/acme/review/pull/12"
        body="![Screenshot](https://example.com/screenshot.png)"
      />,
    );
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("External image · example.com")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load image" }));
    expect(screen.getByRole("img", { name: "Screenshot" })).toHaveAttribute(
      "src",
      "https://example.com/screenshot.png",
    );
  });

  it("leaves plaintext HTTP attachments as links without fetching them", () => {
    const { container } = render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://github.com/acme/review/pull/12"
        body="![Screenshot](http://example.com/screenshot.png)"
      />,
    );
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load image" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open image" })).toHaveAttribute(
      "href",
      "http://example.com/screenshot.png",
    );
  });

  it("separates a linked image from preview controls and fallback links", () => {
    const onOpenImage = vi.fn();
    const { container } = render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://example.com/review/12"
        onOpenImage={onOpenImage}
        body="[![Screenshot](https://example.com/screenshot.png)](https://example.com/full.png)"
      />,
    );
    const button = screen.getByRole("button", {
      name: "Enlarge image: Screenshot",
    });
    expect(button.closest("a")).toBeNull();
    fireEvent.click(button);
    expect(onOpenImage).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("link", { name: "Open linked page" }),
    ).toHaveAttribute("href", "https://example.com/full.png");
    fireEvent.error(screen.getByRole("img", { name: "Screenshot" }));
    expect(container.querySelector("a a")).toBeNull();
    expect(screen.getByRole("link", { name: "Open image" })).toHaveAttribute(
      "href",
      "https://example.com/screenshot.png",
    );
  });

  it("renders a replacement attachment after the previous URL failed", () => {
    const { rerender } = render(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://example.com/review/12"
        body="![Screenshot](https://example.com/before.png)"
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Screenshot" }));
    rerender(
      <ProviderCommentBody
        imageMode="preview"
        imageBaseUrl="https://example.com/review/12"
        body="![Screenshot](https://example.com/after.png)"
      />,
    );
    expect(screen.getByRole("img", { name: "Screenshot" })).toHaveAttribute(
      "src",
      "https://example.com/after.png",
    );
  });
});
