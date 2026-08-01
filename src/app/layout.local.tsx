import "~/styles/globals.css";

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import { AppToaster } from "~/components/app-toaster";
import { ThemePreferenceScript } from "~/components/theme-preference-script";
import { THEME_COOKIE_NAME, themePreference } from "~/lib/theme-preference";
import { TRPCReactProvider } from "~/trpc/react";

const siteDescription =
  "Review local code from the foundations up, remember every sign-off, and focus only on what changed.";

export const metadata: Metadata = {
  applicationName: "ReviewDuck",
  title: { default: "ReviewDuck", template: "%s · ReviewDuck" },
  description: siteDescription,
  icons: {
    icon: [{ url: "/reviewduck.svg", type: "image/svg+xml" }],
    shortcut: "/reviewduck.svg",
    apple: "/reviewduck.svg",
  },
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

/** Renders the telemetry-free root of the local appliance. */
export default async function LocalRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const savedTheme = themePreference(
    (await cookies()).get(THEME_COOKIE_NAME)?.value,
  );
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${geist.variable} ${geistMono.variable}${savedTheme === "dark" ? " dark" : ""}`}
      suppressHydrationWarning
    >
      <head>
        <ThemePreferenceScript nonce={nonce} />
      </head>
      <body className="bg-ink text-cloud antialiased">
        <TRPCReactProvider localMode>{children}</TRPCReactProvider>
        <AppToaster />
      </body>
    </html>
  );
}
