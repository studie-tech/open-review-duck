// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderConnectionMethodPicker } from "./provider-connection-method";

afterEach(cleanup);

describe("ProviderConnectionMethodPicker", () => {
  it("presents PAT as an Azure DevOps fallback without claiming it needs admin approval", async () => {
    const onChange = vi.fn();
    render(
      <ProviderConnectionMethodPicker
        method="managed"
        onChange={onChange}
        provider="azure_devops"
      />,
    );

    expect(screen.getByText("Microsoft Entra")).toBeInTheDocument();
    expect(screen.getByText("Personal access token")).toBeInTheDocument();
    expect(
      screen.getByText(/without asking a tenant admin/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /personal access token/i }),
    );
    expect(onChange).toHaveBeenCalledWith("pat");
  });

  it("keeps the GitHub App as the recommended default", () => {
    render(
      <ProviderConnectionMethodPicker
        method="managed"
        onChange={() => undefined}
        provider="github"
      />,
    );

    expect(
      screen.getByRole("button", { name: /github app.*recommended/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /personal access token/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});
