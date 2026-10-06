export type PullRequestLink = {
  provider: "github" | "gitlab" | "azure_devops";
  repositoryUrl: string;
  number: number;
};

/** Parses a provider PR URL without making a request to the supplied host. */
export function parsePullRequestLink(value: string): PullRequestLink | null {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const match = url.pathname.match(
      /^(.*)\/(pull|-\/merge_requests|pullrequest)\/([1-9]\d*)(?:\/.*)?$/,
    );
    if (!match?.[1]) return null;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number > 2_147_483_647) return null;
    const provider =
      match[2] === "pull"
        ? "github"
        : match[2] === "-/merge_requests"
          ? "gitlab"
          : "azure_devops";
    url.pathname = match[1];
    url.search = "";
    url.hash = "";
    return { provider, repositoryUrl: url.toString(), number };
  } catch {
    return null;
  }
}

/** Compares repository identities while retaining the provider host and path. */
export function matchesPullRequestRepository(
  link: PullRequestLink,
  repository: { provider: string; webUrl: string },
) {
  if (repository.provider !== link.provider) return false;
  try {
    const saved = new URL(repository.webUrl);
    const requested = new URL(link.repositoryUrl);
    /** Normalizes repository paths according to provider case conventions. */
    const normalizePath = (path: string) => {
      const trimmed = path.replace(/\/+$/, "");
      return link.provider === "gitlab" ? trimmed : trimmed.toLowerCase();
    };
    return (
      saved.origin === requested.origin &&
      normalizePath(saved.pathname) === normalizePath(requested.pathname)
    );
  } catch {
    return false;
  }
}
