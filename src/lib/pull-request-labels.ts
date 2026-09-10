/** One provider-defined pull request label. */
export type PullRequestLabel = {
  name: string;
  color?: string;
  description?: string;
};

const FALLBACK_COLORS = [
  "394b59",
  "553c9a",
  "1d4e89",
  "0f6c4d",
  "8a4b08",
  "7a2e0e",
  "6b2d5b",
  "3d5a40",
];

/** Turns provider label payloads into ReviewDuck's stored label shape. */
export function normalizePullRequestLabels(input: unknown): PullRequestLabel[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const labels: PullRequestLabel[] = [];
  for (const item of input) {
    const label = normalizePullRequestLabel(item);
    if (!label || seen.has(label.name)) continue;
    seen.add(label.name);
    labels.push(label);
  }
  return labels;
}

/** Exposes a label's RGB and HSL channels for GitHub-style theme-aware CSS. */
export function pullRequestLabelStyle(label: PullRequestLabel): {
  "--label-r": string;
  "--label-g": string;
  "--label-b": string;
  "--label-h": string;
  "--label-s": string;
  "--label-l": string;
} {
  const color =
    normalizeLabelColor(label.color) ?? fallbackLabelColor(label.name);
  const { r, g, b } = hexToRgb(color);
  const { h, s, l } = rgbToHsl(r, g, b);
  return {
    "--label-r": String(r),
    "--label-g": String(g),
    "--label-b": String(b),
    "--label-h": String(h),
    "--label-s": String(s),
    "--label-l": String(l),
  };
}

/** Accepts one GitHub, GitLab, or Azure DevOps label payload. */
function normalizePullRequestLabel(
  input: unknown,
): PullRequestLabel | undefined {
  if (typeof input === "string") {
    const name = input.trim();
    return name ? { name } : undefined;
  }
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as {
    active?: boolean;
    color?: string | null;
    description?: string | null;
    name?: string | null;
  };
  if (candidate.active === false) return undefined;
  const name = candidate.name?.trim();
  if (!name) return undefined;
  const color = normalizeLabelColor(candidate.color);
  const description = candidate.description?.trim();
  return {
    name,
    ...(color ? { color } : {}),
    ...(description ? { description } : {}),
  };
}

/** Stores provider colors as a 6-digit hex value without a leading hash. */
function normalizeLabelColor(color: string | null | undefined) {
  if (!color) return undefined;
  const hex = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{3,8}$/u.test(hex)) return undefined;
  if (hex.length === 3 || hex.length === 4) {
    return [...hex.slice(0, 3)]
      .map((digit) => `${digit}${digit}`)
      .join("")
      .toLowerCase();
  }
  return hex.slice(0, 6).toLowerCase();
}

/** Picks a stable muted color when the provider does not send one. */
function fallbackLabelColor(name: string) {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? "394b59";
}

/** Parses a stored 6-digit hex color into 0–255 RGB channels. */
function hexToRgb(hex: string) {
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/** Converts RGB channels into the HSL values GitHub's label CSS expects. */
function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) {
    return { h: 0, s: 0, l: Math.round(l * 100) };
  }
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return {
    h: Math.round(h * 60),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}
