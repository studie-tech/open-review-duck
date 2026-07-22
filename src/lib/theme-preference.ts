export const THEME_COOKIE_NAME = "reviewduck-theme";
export const THEME_STORAGE_KEY = "reviewduck-theme";

export type ThemePreference = "dark" | "light";

/** Narrows persisted input to one supported theme preference. */
export function themePreference(
  value: string | null | undefined,
): ThemePreference | undefined {
  return value === "dark" || value === "light" ? value : undefined;
}
