import { describe, expect, it } from "vitest";
import {
  normalizePullRequestLabels,
  pullRequestLabelStyle,
} from "./pull-request-labels";

describe("pull request labels", () => {
  it("normalizes GitHub, GitLab, and Azure DevOps label payloads", () => {
    expect(
      normalizePullRequestLabels([
        {
          name: "size:XXL",
          color: "B60205",
          description: "Extra extra large",
        },
        { name: "size:XXL", color: "ffffff" },
        { name: "  bug  ", color: "#d73a4a" },
        "hotfix",
        { name: "inactive", active: false },
        { name: "   " },
        { color: "fff" },
      ]),
    ).toEqual([
      {
        name: "size:XXL",
        color: "b60205",
        description: "Extra extra large",
      },
      { name: "bug", color: "d73a4a" },
      { name: "hotfix" },
    ]);
    expect(normalizePullRequestLabels(undefined)).toEqual([]);
  });

  it("exposes GitHub label channels for theme-aware CSS", () => {
    expect(
      pullRequestLabelStyle({ name: "size:XXL", color: "b60205" }),
    ).toEqual({
      "--label-r": "182",
      "--label-g": "2",
      "--label-b": "5",
      "--label-h": "359",
      "--label-s": "98",
      "--label-l": "36",
    });
    expect(pullRequestLabelStyle({ name: "hotfix" })).toEqual(
      pullRequestLabelStyle({ name: "hotfix" }),
    );
  });
});
