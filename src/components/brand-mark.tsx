import type { SVGProps } from "react";

/** Renders the brand mark interface. */
export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 120 120"
      role="img"
      aria-label="ReviewDuck"
      className={className}
      {...props}
    >
      <rect
        x="6"
        y="30"
        width="72"
        height="66"
        rx="13"
        fill="var(--brand-pane-back)"
      />
      <rect
        x="44"
        y="18"
        width="70"
        height="66"
        rx="13"
        fill="var(--brand-pane-front)"
      />
      <path
        d="M18 49h20M18 59h13M18 69h18"
        fill="none"
        stroke="var(--brand-ink)"
        strokeLinecap="round"
        strokeWidth="5"
      />
      <path
        d="M91 40h12M94 50h9M92 60h11"
        fill="none"
        stroke="var(--brand-ink)"
        strokeLinecap="round"
        strokeWidth="5"
      />
      <path
        d="M70 42c0-10-8-18-18-18s-18 8-18 18c0 6 3 11 7 14-10 4-17 12-17 22 0 13 11 22 27 22h13c14 0 24-9 24-21 0-10-7-18-17-22 8-1 16-5 22-11-7-3-15-5-23-4Z"
        fill="var(--brand-duck)"
      />
      <circle cx="56" cy="38" r="3.5" fill="var(--brand-ink)" />
    </svg>
  );
}
