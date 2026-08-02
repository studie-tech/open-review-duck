// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { lockDocumentScroll } from "./document-scroll-lock";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

describe("lockDocumentScroll", () => {
  it("prevents outer scrolling and restores the existing document styles", () => {
    document.documentElement.style.overflow = "clip";
    document.documentElement.style.overscrollBehavior = "contain";
    document.body.style.overflow = "auto";
    document.body.style.overscrollBehavior = "auto";

    const unlock = lockDocumentScroll(document);

    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overscrollBehavior).toBe("none");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("none");

    unlock();

    expect(document.documentElement.style.overflow).toBe("clip");
    expect(document.documentElement.style.overscrollBehavior).toBe("contain");
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.overscrollBehavior).toBe("auto");
  });
});
