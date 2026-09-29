export type InboxInvolvement = "all" | "assigned" | "created" | "both";

export const inboxInvolvementChoices: readonly {
  description: string;
  id: InboxInvolvement;
  label: string;
}[] = [
  {
    id: "all",
    label: "Anyone",
    description: "No filter on who opened or is assigned the pull request",
  },
  {
    id: "assigned",
    label: "Assigned to me",
    description: "You are a requested reviewer or an assignee",
  },
  {
    id: "created",
    label: "Created by me",
    description: "You opened the pull request",
  },
  {
    id: "both",
    label: "Both",
    description: "You opened it, and you are a reviewer or assignee",
  },
];

/** Reports whether a stored value is one of the four involvement choices. */
export function isInboxInvolvement(value: unknown): value is InboxInvolvement {
  return inboxInvolvementChoices.some((choice) => choice.id === value);
}

/**
 * Keeps a pull request when the selected involvement matches.
 * Anyone keeps every row. Both keeps the intersection, not the union.
 */
export function matchesInboxInvolvement(
  pullRequest: { assignedToViewer?: boolean; authoredByViewer?: boolean },
  involvement: InboxInvolvement = "all",
) {
  if (involvement === "all") return true;
  const assigned = pullRequest.assignedToViewer === true;
  const created = pullRequest.authoredByViewer === true;
  if (involvement === "assigned") return assigned;
  if (involvement === "created") return created;
  return assigned && created;
}

/** Explains an empty inbox when the involvement choice removed every row. */
export function inboxInvolvementEmptyDetail(involvement: InboxInvolvement) {
  if (involvement === "assigned") return "None of these are assigned to you.";
  if (involvement === "created") return "None of these were opened by you.";
  if (involvement === "both") {
    return "None of these were both opened by you and assigned to you.";
  }
  return "Try another repository, provider, or search.";
}

/** Keeps provider account ids that can be compared with a connected user. */
export function providerAccountIds(
  people:
    | readonly ({ id?: number | string | null } | null | undefined)[]
    | null
    | undefined,
) {
  const ids: string[] = [];
  for (const person of people ?? []) {
    if (person?.id == null || person.id === "") continue;
    ids.push(String(person.id));
  }
  return ids;
}

/** Columns that record who opened a pull request and who is asked to review it. */
export function pullRequestParticipantColumns(summary: {
  assigneeExternalIds?: readonly string[] | null;
  authorExternalId?: string | null;
  reviewerExternalIds?: readonly string[] | null;
}) {
  return {
    assigneeExternalIds: [...(summary.assigneeExternalIds ?? [])],
    authorExternalId: summary.authorExternalId ?? null,
    reviewerExternalIds: [...(summary.reviewerExternalIds ?? [])],
  };
}

/**
 * Decides whether this reviewer opened the pull request or is asked to review it.
 * Account ids win once a sync has stored them. Until then, an assigned intake
 * source and a matching login still count.
 */
export function viewerOwnsPullRequest(input: {
  accountIds: readonly (string | null | undefined)[];
  assigneeExternalIds?: readonly string[] | null;
  authorExternalId?: string | null;
  authorLogin: string;
  logins: readonly (string | null | undefined)[];
  queueSource?: string | null;
  reviewerExternalIds?: readonly string[] | null;
}) {
  const accounts = new Set(
    input.accountIds.flatMap((id) => {
      const value = id?.trim();
      return value ? [value] : [];
    }),
  );
  const logins = new Set(
    input.logins.flatMap((login) => {
      const value = login?.trim().toLowerCase();
      return value ? [value] : [];
    }),
  );
  const authorLogin = input.authorLogin.trim().toLowerCase();
  const authorId = input.authorExternalId?.trim() ?? "";
  const participantsKnown = authorId.length > 0;
  const authoredByViewer =
    (authorId.length > 0 && accounts.has(authorId)) ||
    (!participantsKnown && authorLogin.length > 0 && logins.has(authorLogin));
  const assignedIds = [
    ...(input.reviewerExternalIds ?? []),
    ...(input.assigneeExternalIds ?? []),
  ];
  const assignedById = assignedIds.some((id) => accounts.has(id));
  const assignedToViewer = participantsKnown
    ? assignedById
    : input.queueSource === "assigned" || assignedById;
  return { assignedToViewer, authoredByViewer };
}
