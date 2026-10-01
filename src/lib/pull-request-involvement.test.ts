import { describe, expect, it } from "vitest";
import {
  inboxInvolvementEmptyDetail,
  matchesInboxInvolvement,
  viewerOwnsPullRequest,
} from "./pull-request-involvement";

describe("inbox involvement", () => {
  const mine = { assignedToViewer: true, authoredByViewer: true };
  const assigned = { assignedToViewer: true, authoredByViewer: false };
  const created = { assignedToViewer: false, authoredByViewer: true };
  const other = { assignedToViewer: false, authoredByViewer: false };

  it("treats anyone as no personal filter and both as the intersection", () => {
    expect(matchesInboxInvolvement(other, "all")).toBe(true);
    expect(matchesInboxInvolvement(assigned, "assigned")).toBe(true);
    expect(matchesInboxInvolvement(created, "assigned")).toBe(false);
    expect(matchesInboxInvolvement(created, "created")).toBe(true);
    expect(matchesInboxInvolvement(mine, "both")).toBe(true);
    expect(matchesInboxInvolvement(assigned, "both")).toBe(false);
    expect(matchesInboxInvolvement(created, "both")).toBe(false);
  });

  it("explains an empty list in the words of the selected choice", () => {
    expect(inboxInvolvementEmptyDetail("all")).toBe(
      "Try another repository, provider, or search.",
    );
    expect(inboxInvolvementEmptyDetail("created")).toBe(
      "None of these were opened by you.",
    );
  });
});

describe("viewer ownership", () => {
  it("matches a stored author and reviewer id to the connected account", () => {
    expect(
      viewerOwnsPullRequest({
        accountIds: ["42"],
        assigneeExternalIds: [],
        authorExternalId: "42",
        authorLogin: "ada",
        logins: ["Ada Lovelace"],
        reviewerExternalIds: ["42"],
      }),
    ).toEqual({ assignedToViewer: true, authoredByViewer: true });
  });

  it("does not treat a display name as authorship once the author id is known", () => {
    expect(
      viewerOwnsPullRequest({
        accountIds: ["7"],
        authorExternalId: "42",
        authorLogin: "ada",
        logins: ["ada"],
        reviewerExternalIds: [],
      }),
    ).toEqual({ assignedToViewer: false, authoredByViewer: false });
  });

  it("falls back to login and assigned intake before a sync has stored ids", () => {
    expect(
      viewerOwnsPullRequest({
        accountIds: ["42"],
        authorLogin: "Ada",
        logins: ["ada"],
        queueSource: "manual",
      }).authoredByViewer,
    ).toBe(true);
    expect(
      viewerOwnsPullRequest({
        accountIds: ["42"],
        authorLogin: "other",
        logins: ["ada"],
        queueSource: "assigned",
      }).assignedToViewer,
    ).toBe(true);
    expect(
      viewerOwnsPullRequest({
        accountIds: ["42"],
        authorLogin: "other",
        logins: ["ada"],
        queueSource: "all",
      }),
    ).toEqual({ assignedToViewer: false, authoredByViewer: false });
  });
});
