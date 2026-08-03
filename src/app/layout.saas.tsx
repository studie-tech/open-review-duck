import "~/styles/globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";

import { AppToaster } from "~/components/app-toaster";
import { ThemePreferenceScript } from "~/components/theme-preference-script";
import { THEME_COOKIE_NAME, themePreference } from "~/lib/theme-preference";
import { assertDeploymentConfigured } from "~/server/deployment";
import { TRPCReactProvider } from "~/trpc/react";

const siteDescription =
  "Review pull requests from the foundations up, remember every sign-off, and focus only on what changed.";

export const metadata: Metadata = {
  metadataBase: new URL("https://reviewduck.ai"),
  applicationName: "ReviewDuck",
  title: { default: "ReviewDuck.ai", template: "%s · ReviewDuck.ai" },
  description: siteDescription,
  icons: {
    icon: [{ url: "/reviewduck.svg", type: "image/svg+xml" }],
    shortcut: "/reviewduck.svg",
    apple: "/reviewduck.svg",
  },
  openGraph: {
    type: "website",
    url: "https://reviewduck.ai",
    siteName: "ReviewDuck",
    title: "ReviewDuck.ai",
    description: siteDescription,
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

/** Renders the root layout interface. */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const savedTheme = themePreference(
    (await cookies()).get(THEME_COOKIE_NAME)?.value,
  );
  assertDeploymentConfigured();
  const application = (
    <body className="bg-ink text-cloud antialiased">
      <TRPCReactProvider localMode={false}>{children}</TRPCReactProvider>
      <AppToaster />
    </body>
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
      <ClerkProvider
        dynamic
        nonce={nonce}
        appearance={{
          variables: {
            colorPrimary: "var(--app-accent)",
            colorBackground: "var(--app-surface)",
            colorForeground: "var(--app-text)",
            colorMutedForeground: "var(--app-text-muted)",
            borderRadius: "0.75rem",
          },
        }}
      >
        {application}
      </ClerkProvider>
    </html>
  );
}
