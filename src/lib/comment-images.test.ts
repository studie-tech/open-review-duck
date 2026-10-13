import { describe, expect, it } from "vitest";
import {
  canAutomaticallyPreviewCommentImage,
  providerCommentHasImages,
} from "./comment-images";

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

  it("includes bare relative image filenames and ignores inline code examples", () => {
    expect(providerCommentHasImages("![Screenshot](screenshot.png)")).toBe(
      true,
    );
    expect(
      providerCommentHasImages('<img src="screenshot.png" alt="Screenshot">'),
    ).toBe(true);
    expect(
      providerCommentHasImages(
        "`![Screenshot](https://example.com/image.png)`",
      ),
    ).toBe(false);
  });
});

describe("canAutomaticallyPreviewCommentImage", () => {
  it("permits HTTPS provider origins and documented GitHub attachment hosts", () => {
    expect(
      canAutomaticallyPreviewCommentImage(
        "https://gitlab.example/team/project/uploads/image.png",
        "https://gitlab.example/team/project/-/merge_requests/12",
      ),
    ).toBe(true);
    expect(
      canAutomaticallyPreviewCommentImage(
        "https://dev.azure.com/acme/_apis/attachments/image",
        "https://dev.azure.com/acme/project/_git/repo/pullrequest/12",
      ),
    ).toBe(true);
    expect(
      canAutomaticallyPreviewCommentImage(
        "https://user-images.githubusercontent.com/image.png",
      ),
    ).toBe(true);
    expect(
      canAutomaticallyPreviewCommentImage(
        "https://private-user-images.githubusercontent.com/image.png",
      ),
    ).toBe(true);
  });

  it("does not auto-load third-party, spoofed, or plaintext origins", () => {
    expect(
      canAutomaticallyPreviewCommentImage(
        "https://example.com/image.png",
        "https://github.com/acme/review/pull/12",
      ),
    ).toBe(false);
    expect(
      canAutomaticallyPreviewCommentImage(
        "https://user-images.githubusercontent.com.example.com/image.png",
      ),
    ).toBe(false);
    expect(
      canAutomaticallyPreviewCommentImage(
        "http://github.com/image.png",
        "http://github.com/acme/review/pull/12",
      ),
    ).toBe(false);
  });
});
