import Script from "next/script";
import { THEME_COOKIE_NAME, THEME_STORAGE_KEY } from "~/lib/theme-preference";

const themeScript = `
  (() => {
    try {
      const saved = localStorage.getItem("${THEME_STORAGE_KEY}");
      const dark = saved === "dark" ||
        (saved !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      if (saved === "dark" || saved === "light") {
        document.cookie = "${THEME_COOKIE_NAME}=" + saved +
          "; Path=/; Max-Age=31536000; SameSite=Lax";
      }
      const syncFavicon = () => {
        for (const icon of document.querySelectorAll('link[rel~="icon"]')) {
          icon.href = "/reviewduck.svg#" + (dark ? "dark" : "light");
        }
      };
      syncFavicon();
      document.addEventListener("DOMContentLoaded", syncFavicon, { once: true });
    } catch {}
  })();
`;

/** Restores client-side theme state and migrates it to the server cookie. */
export function ThemePreferenceScript({ nonce }: { nonce?: string }) {
  return (
    <Script id="theme-preference" nonce={nonce} strategy="afterInteractive">
      {themeScript}
    </Script>
  );
}
