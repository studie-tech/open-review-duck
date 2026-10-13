import { describe, expect, it } from "vitest";
import { providerCommentHasImages } from "./comment-images";

describe("providerCommentHasImages", () => {
  it("recognizes Markdown and HTML attachments", () => {
    expect(
      providerCommentHasImages("![Result](https://example.com/result.png)"),
    ).toBe(true);
    expect(
      providerCommentHasImages(
        '<img width="600" src="https://example.com/result.png" alt="Result">',
      ),
    ).toBe(true);
  });

  it("excludes local priority badges, plain links, and unsafe image URLs", () => {
    expect(
      providerCommentHasImages("![P2](https://example.com/badge.svg)"),
    ).toBe(false);
    expect(
      providerCommentHasImages(
        '<img src="https://example.com/badge.svg" alt="P1">',
      ),
    ).toBe(false);
    expect(
      providerCommentHasImages("[Screenshot](https://example.com/result.png)"),
    ).toBe(false);
    expect(
      providerCommentHasImages('<img src="javascript:alert(1)" alt="Result">'),
    ).toBe(false);
  });

  it("includes relative and reference attachments but ignores fenced examples", () => {
    expect(providerCommentHasImages("![Result](/uploads/abc/result.png)")).toBe(
      true,
    );
    expect(
      providerCommentHasImages(
        "![Result][upload]\n\n[upload]: /uploads/abc/result.png",
      ),
    ).toBe(true);
    expect(
      providerCommentHasImages(
        "```md\n![Result](https://example.com/result.png)\n```",
      ),
    ).toBe(false);
  });
});
