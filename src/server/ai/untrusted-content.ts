import "server-only";

/** Escapes untrusted text without changing its reviewer-visible content. */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Frames repository source so its contents cannot become model instructions. */
export function untrustedFileSource(path: string, source: string): string {
  const safePath = escapeXml(path).replaceAll('"', "&quot;");
  return `<untrusted-file path="${safePath}">${escapeXml(source)}</untrusted-file>`;
}
