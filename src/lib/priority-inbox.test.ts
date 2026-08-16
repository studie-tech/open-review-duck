import { describe, expect, it } from "vitest";
import {
  comparePriorityInboxText,
  filterPriorityInbox,
  type PriorityInboxItem,
  prioritizeInbox,
  priorityInboxGroup,
  priorityInboxRepositoryKey,
} from "./priority-inbox";

/** Builds one prioritizable item with focused test overrides. */
const item = (
  overrides: Partial<PriorityInboxItem> & Pick<PriorityInboxItem, "id">,
): PriorityInboxItem => ({
  additions: 12,
  authorLogin: "reviewer",
  deletions: 2,
  number: 42,
  provider: "github",
  repositoryName: "web",
  repositoryOwner: "acme",
  signedUnits: 0,
  state: "open",
  title: "Improve the dashboard",
  totalUnits: 4,
  ...overrides,
});

describe("priority inbox", () => {
  it("puts continued work ahead of untouched and unsupported reviews", () => {
    const ordered = prioritizeInbox([
      item({ id: "unsupported", totalUnits: 0 }),
      item({ id: "ready-z", repositoryName: "zebra" }),
      item({ id: "continue", signedUnits: 2 }),
      item({ id: "ready-a", repositoryName: "accounts" }),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual([
      "continue",
      "ready-a",
      "ready-z",
      "unsupported",
    ]);
    const first = ordered.at(0);
    expect(first).toBeDefined();
    if (first) {
      expect(priorityInboxGroup(first)).toMatchObject({ id: "continue" });
    }
  });

  it("combines view, provider, repository, and text filters", () => {
    const target = item({
      id: "target",
      provider: "gitlab",
      repositoryOwner: "payments",
      repositoryName: "api",
      authorLogin: "sonia",
      title: "Retry settlement webhooks",
      signedUnits: 1,
    });
    const result = filterPriorityInbox(
      [target, item({ id: "other", signedUnits: 1 })],
      {
        view: "continue",
        provider: "gitlab",
        repository: priorityInboxRepositoryKey(target),
        search: "payments/api Settlement #42 SONIA",
      },
    );

    expect(result).toEqual([target]);
    expect(
      filterPriorityInbox([target], {
        view: "continue",
        provider: "gitlab",
        repository: priorityInboxRepositoryKey(target),
        search: "settlement",
      }),
    ).toEqual([target]);
    expect(
      filterPriorityInbox([target], {
        view: "all",
        provider: "all",
        repository: "all",
        search: "42",
      }),
    ).toEqual([target]);
  });

  it("keeps same-named repositories distinct across providers", () => {
    const github = item({ id: "github" });
    const gitlab = item({ id: "gitlab", provider: "gitlab" });

    expect(priorityInboxRepositoryKey(github)).not.toBe(
      priorityInboxRepositoryKey(gitlab),
    );
  });

  it("orders non-ASCII repository names independently of runtime locale", () => {
    const names = ["æble", "åland", "zoo"];

    expect(names.sort(comparePriorityInboxText)).toEqual([
      "zoo",
      "åland",
      "æble",
    ]);
    expect(
      prioritizeInbox(
        names.map((repositoryName) =>
          item({ id: repositoryName, repositoryName }),
        ),
      ).map(({ repositoryName }) => repositoryName),
    ).toEqual(["zoo", "åland", "æble"]);
  });
});
