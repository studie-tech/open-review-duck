// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useReviewDialogController } from "./use-review-dialog-controller";

afterEach(cleanup);

describe("discussion command suspension", () => {
  it("suspends workspace commands while discussions are open and restores them on close", () => {
    const { result, rerender } = renderHook(
      ({ discussionsOpen }) =>
        useReviewDialogController({
          discussionsOpen,
          importPreviewOpen: false,
          linePickerOpen: false,
        }),
      { initialProps: { discussionsOpen: false } },
    );
    expect(result.current.commandBindingsSuspended).toBe(false);
    rerender({ discussionsOpen: true });
    expect(result.current.commandBindingsSuspended).toBe(true);
    rerender({ discussionsOpen: false });
    expect(result.current.commandBindingsSuspended).toBe(false);
  });
});
