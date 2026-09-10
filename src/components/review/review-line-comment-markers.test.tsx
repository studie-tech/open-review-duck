// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewLineCommentMarkers,
  reviewLineCommentMarkersBySide,
  reviewLineCommentMarkersForLine,
} from "./review-line-comment-markers";

afterEach(cleanup);

/** Builds one provider thread for marker grouping tests. */
function thread(input: {
  author: string;
  avatar?: string;
  id: string;
  line: number;
  side?: "left" | "right";
  status?: string;
}) {
  return {
    comments: [
      {
        author: input.author,
        authorAvatarUrl: input.avatar,
      },
    ],
    externalId: input.id,
    line: input.line,
    side: input.side ?? "right",
    status: input.status ?? "open",
  };
}

describe("reviewLineCommentMarkersBySide", () => {
  it("keeps left and right conversations on their own line gutters", () => {
    const grouped = reviewLineCommentMarkersBySide([
      thread({ author: "ada", id: "1", line: 12, side: "right" }),
      thread({
        author: "grace",
        id: "2",
        line: 12,
        side: "left",
        status: "resolved",
      }),
      thread({ author: "ada", id: "3", line: 40 }),
    ]);

    expect(reviewLineCommentMarkersForLine(grouped, 12, "right")).toEqual([
      {
        author: "ada",
        authorAvatarUrl: undefined,
        resolved: false,
        threadExternalId: "1",
      },
    ]);
    expect(reviewLineCommentMarkersForLine(grouped, 12, "left")).toEqual([
      {
        author: "grace",
        authorAvatarUrl: undefined,
        resolved: true,
        threadExternalId: "2",
      },
    ]);
    expect(reviewLineCommentMarkersForLine(grouped, 12)).toHaveLength(2);
    expect(reviewLineCommentMarkersForLine(grouped, 40, "right")).toHaveLength(
      1,
    );
    expect(reviewLineCommentMarkersForLine(grouped, 99)).toEqual([]);
  });

  it("skips a conversation that has no comments to attribute", () => {
    const grouped = reviewLineCommentMarkersBySide([
      {
        comments: [],
        externalId: "empty",
        line: 8,
        side: "right",
        status: "open",
      },
    ]);

    expect(reviewLineCommentMarkersForLine(grouped, 8)).toEqual([]);
  });
});

describe("ReviewLineCommentMarkers", () => {
  it("opens the named conversation from its poster avatar", async () => {
    const onOpen = vi.fn();
    render(
      <ReviewLineCommentMarkers
        markers={[
          {
            author: "ada",
            authorAvatarUrl: "https://avatars.example/ada.png",
            resolved: true,
            threadExternalId: "thread-ada",
          },
        ]}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByRole("presentation")).toHaveAttribute(
      "src",
      "https://avatars.example/ada.png",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Open resolved comment by ada",
      }),
    );
    expect(onOpen).toHaveBeenCalledWith("thread-ada");
  });

  it("falls back to an initial and stacks extra conversations", async () => {
    const onOpen = vi.fn();
    render(
      <ReviewLineCommentMarkers
        markers={[
          {
            author: "ada",
            resolved: false,
            threadExternalId: "one",
          },
          {
            author: "grace",
            resolved: false,
            threadExternalId: "two",
          },
          {
            author: "alonzo",
            resolved: false,
            threadExternalId: "three",
          },
        ]}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("G")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "3 comments on this line" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Open comment by grace" }),
    );
    expect(onOpen).toHaveBeenCalledWith("two");
  });
});
