import { SignUp } from "@clerk/nextjs";
import Link from "next/link";

import { BrandMark } from "~/components/brand-mark";
import { ThemeToggle } from "~/components/theme-toggle";

/** Renders the sign up page interface. */
export default function SignUpPage() {
  return (
    <main className="bg-ink relative grid min-h-screen place-items-center overflow-hidden p-5">
      <div className="studio-glow pointer-events-none absolute inset-0" />
      <Link
        href="/"
        className="absolute top-6 left-6 z-10 flex items-center gap-3 font-semibold"
      >
        <BrandMark className="size-10" />
        ReviewDuck.ai
      </Link>
      <ThemeToggle className="absolute top-6 right-6 z-10" />
      <div className="relative z-[1]">
        <SignUp />
      </div>
    </main>
  );
}
