// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryFilter, repositoryFilterLabel } from "./repository-filter";

const repositories = [
  {
    key: "github:studie-tech/TheNinjaF",
    label: "studie-tech/TheNinjaF",
    provider: "github" as const,
  },
  {
    key: "gitlab:payments/api",
    label: "payments/api",
    provider: "gitlab" as const,
  },
];

afterEach(cleanup);

describe("repositoryFilterLabel", () => {
  it("summarizes none, one, or several selected repositories", () => {
    expect(repositoryFilterLabel(repositories, [])).toBe("All repositories");
    expect(repositoryFilterLabel(repositories, ["gitlab:payments/api"])).toBe(
      "payments/api",
    );
    expect(
      repositoryFilterLabel(repositories, [
        "github:studie-tech/TheNinjaF",
        "gitlab:payments/api",
      ]),
    ).toBe("2 repositories");
  });
});

describe("RepositoryFilter", () => {
  it("lets the reviewer keep more than one repository selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <RepositoryFilter
        onChange={onChange}
        providerFilter="all"
        repositories={repositories}
        selected={[]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Filter by repository" }),
    );
    expect(
      screen.getByRole("option", { name: "All repositories" }),
    ).toHaveAttribute("aria-selected", "true");

    await user.click(
      screen.getByRole("option", { name: "studie-tech/TheNinjaF · GitHub" }),
    );
    expect(onChange).toHaveBeenCalledWith(["github:studie-tech/TheNinjaF"]);

    view.rerender(
      <RepositoryFilter
        onChange={onChange}
        providerFilter="all"
        repositories={repositories}
        selected={["github:studie-tech/TheNinjaF"]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Filter by repository" }),
    ).toHaveTextContent("studie-tech/TheNinjaF");

    await user.click(
      screen.getByRole("option", { name: "payments/api · GitLab" }),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      "github:studie-tech/TheNinjaF",
      "gitlab:payments/api",
    ]);
  });
});
