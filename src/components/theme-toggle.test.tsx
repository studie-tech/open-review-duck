// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_COOKIE_NAME } from "~/lib/theme-preference";
import { ThemeToggle } from "./theme-toggle";

const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();

beforeEach(() => {
  localStorage.clear();
  // biome-ignore lint/suspicious/noDocumentCookie: tests reset the browser preference between cases
  document.cookie = `${THEME_COOKIE_NAME}=; Path=/; Max-Age=0`;
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  document.head.innerHTML =
    '<link rel="icon" type="image/svg+xml" href="/reviewduck.svg">';
  mediaListeners.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => mediaListeners.add(listener),
      removeEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => mediaListeners.delete(listener),
      dispatchEvent: () => true,
    })),
  });
});

afterEach(cleanup);

describe("ThemeToggle", () => {
  it("switches to dark mode and persists the choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const toggle = await screen.findByRole("button", {
      name: "Toggle color theme",
    });
    await user.click(toggle);

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("reviewduck-theme")).toBe("dark");
    expect(document.cookie).toContain(`${THEME_COOKIE_NAME}=dark`);
    expect(toggle).toHaveAccessibleName("Toggle color theme");
    expect(
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href,
    ).toMatch(/\/reviewduck\.svg#dark$/);
  });

  it("tracks system changes until the user chooses a theme", async () => {
    render(<ThemeToggle />);

    for (const listener of mediaListeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }

    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(localStorage.getItem("reviewduck-theme")).toBeNull();
  });
});
