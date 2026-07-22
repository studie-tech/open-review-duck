"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect } from "react";

import {
  THEME_COOKIE_NAME,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "~/lib/theme-preference";
import { cn } from "~/lib/utils";

/** Returns the theme currently applied to the document. */
function getCurrentTheme(): ThemePreference {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Updates the favicon assets to match the active color theme. */
function syncFavicon(theme: ThemePreference) {
  for (const icon of document.querySelectorAll<HTMLLinkElement>(
    'link[rel~="icon"]',
  )) {
    icon.href = `/reviewduck.svg#${theme}`;
  }
}

/** Applies the selected color theme to the current document. */
function applyTheme(theme: ThemePreference) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  syncFavicon(theme);
}

/** Renders the theme toggle interface. */
export function ThemeToggle({ className }: { className?: string }) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /** Applies a system theme change when no explicit preference is stored. */
    const syncSystemTheme = (event: MediaQueryListEvent) => {
      if (localStorage.getItem(THEME_STORAGE_KEY)) {
        return;
      }

      const nextTheme = event.matches ? "dark" : "light";
      applyTheme(nextTheme);
    };

    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  return (
    <button
      type="button"
      aria-label="Toggle color theme"
      title="Toggle color theme"
      onClick={() => {
        const nextTheme = getCurrentTheme() === "dark" ? "light" : "dark";
        applyTheme(nextTheme);
        localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        // biome-ignore lint/suspicious/noDocumentCookie: the cookie lets the server render the selected theme before hydration
        document.cookie = `${THEME_COOKIE_NAME}=${nextTheme}; Path=/; Max-Age=31536000; SameSite=Lax`;
      }}
      className={cn(
        "text-mist hover:text-cloud hover:bg-surface-hover grid size-10 place-items-center rounded-xl border border-line bg-surface/75 transition",
        className,
      )}
    >
      <Moon className="size-[17px] dark:hidden" aria-hidden="true" />
      <Sun className="hidden size-[17px] dark:block" aria-hidden="true" />
    </button>
  );
}
