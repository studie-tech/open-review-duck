// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderTokenGuide } from "./provider-token-guide";

afterEach(cleanup);

describe("ProviderTokenGuide", () => {
  it("explains GitHub fine-grained repository and pull request permissions", () => {
    const { container } = render(<ProviderTokenGuide provider="github" />);

    expect(
      screen.getByText("Create a GitHub access token"),
    ).toBeInTheDocument();
    expect(screen.getByText("Selected repositories")).toBeInTheDocument();
    expect(screen.getAllByText("Read and write").length).toBeGreaterThan(0);
    expect(screen.queryByText("Corporate setup")).not.toBeInTheDocument();
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(
      screen.getByRole("link", {
        name: "GitHub’s fine-grained token page",
      }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("github.com/settings/personal-access-tokens/new"),
    );
    expect(
      screen.getByRole("link", { name: "Open GitHub token settings" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("github.com/settings/personal-access-tokens/new"),
    );
  });

  it("makes the GitLab API scope and project token option explicit", () => {
    render(
      <ProviderTokenGuide
        provider="gitlab"
        baseUrl="https://gitlab.corp.example/api/v4"
      />,
    );

    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("Developer or higher")).toBeInTheDocument();
    expect(screen.queryByText("Corporate setup")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "GitLab’s personal access token page",
      }),
    ).toHaveAttribute(
      "href",
      "https://gitlab.corp.example/-/user_settings/personal_access_tokens",
    );
    expect(
      screen.getByRole("link", { name: "Open GitLab token settings" }),
    ).toHaveAttribute(
      "href",
      "https://gitlab.corp.example/-/user_settings/personal_access_tokens",
    );
  });

  it("uses the Azure organization URL and documents the review-vote scope", () => {
    render(
      <ProviderTokenGuide
        provider="azure_devops"
        baseUrl="https://dev.azure.com/reviewduck/"
      />,
    );

    expect(screen.getByText("Read & write")).toBeInTheDocument();
    expect(
      screen.getByText(/requires code-write access to submit approval/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Corporate setup")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "your Azure DevOps token settings",
      }),
    ).toHaveAttribute(
      "href",
      "https://dev.azure.com/reviewduck/_usersSettings/tokens",
    );
    expect(
      screen.getByRole("link", {
        name: "Open Azure DevOps token settings",
      }),
    ).toHaveAttribute(
      "href",
      "https://dev.azure.com/reviewduck/_usersSettings/tokens",
    );
  });
});
