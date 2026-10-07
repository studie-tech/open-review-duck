// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import { useStagedReviewWorkspace } from "./use-staged-review-workspace";

type Workspace = RouterOutputs["review"]["workspace"];

/** Builds the immutable revision identity used by this boundary. */
function workspace(id: string, title = id) {
  return { snapshot: { id }, pullRequest: { title } } as Workspace;
}

describe("useStagedReviewWorkspace", () => {
  it("accepts metadata but stages newer code until the controller requests loading", () => {
    const first = workspace("one");
    const { result, rerender } = renderHook(
      ({ incoming }) => useStagedReviewWorkspace(incoming),
      { initialProps: { incoming: first } },
    );
    const metadata = workspace("one", "updated title");
    rerender({ incoming: metadata });
    expect(result.current.displayed).toBe(metadata);
    const second = workspace("two");
    rerender({ incoming: second });
    expect(result.current.displayed).toBe(metadata);
    expect(result.current.available).toBe(true);
    const third = workspace("three");
    rerender({ incoming: third });
    expect(result.current.displayed).toBe(metadata);
    act(() => result.current.requestLoad());
    rerender({ incoming: third });
    expect(result.current.displayed).toBe(third);
    expect(result.current.available).toBe(false);
    rerender({ incoming: workspace("four") });
    expect(result.current.displayed).toBe(third);
  });

  it("permits a load request before its refresh response arrives", () => {
    const first = workspace("one");
    const { result, rerender } = renderHook(
      ({ incoming }) => useStagedReviewWorkspace(incoming),
      { initialProps: { incoming: first } },
    );
    act(() => result.current.requestLoad());
    rerender({ incoming: first });
    expect(result.current.displayed).toBe(first);
    const next = workspace("two");
    rerender({ incoming: next });
    expect(result.current.displayed).toBe(next);
  });
});
