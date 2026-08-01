/** Validates and normalizes an Azure DevOps Services organization URL. */
export function normalizeAzureOrganizationUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Azure DevOps organization URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("Enter a valid Azure DevOps organization URL");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "dev.azure.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) {
      throw new Error(
        "Use the Azure DevOps organization URL, for example https://dev.azure.com/example",
      );
    }
    return `https://dev.azure.com/${encodeURIComponent(decodeURIComponent(segments[0] ?? ""))}`;
  }

  if (
    hostname.endsWith(".visualstudio.com") &&
    hostname.split(".").length === 3 &&
    (url.pathname === "/" || url.pathname === "")
  ) {
    return `https://${hostname}`;
  }

  throw new Error(
    "Azure DevOps Services URLs must use dev.azure.com or an organization.visualstudio.com host",
  );
}
