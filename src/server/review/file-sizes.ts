import type { PullRequestProvider } from "~/server/providers/types";

/** Looks up current sizes, or the last version of deleted files, by snapshot. */
export async function reviewFileSizes(input: {
  provider: PullRequestProvider;
  repositoryExternalId: string;
  headSha: string;
  baseSha: string;
  files: readonly { path: string; changeType: string }[];
}): Promise<Record<string, number | null>> {
  const { provider, repositoryExternalId, files, headSha, baseSha } = input;
  const sizes = new Map<string, number | null>(
    files.map(({ path }) => [path, null]),
  );
  if (!provider.getRepositoryFileSizes || files.length === 0) {
    return Object.fromEntries(sizes);
  }
  const getSizes = provider.getRepositoryFileSizes.bind(provider);
  await Promise.all(
    [false, true].map(async (deleted) => {
      const members = files.filter(
        (file) => (file.changeType === "deleted") === deleted,
      );
      if (members.length === 0) return;
      try {
        const ref = deleted
          ? ((await provider.getPullRequestDiffBase?.(
              repositoryExternalId,
              baseSha,
              headSha,
            )) ?? baseSha)
          : headSha;
        const metadata = await getSizes(repositoryExternalId, ref);
        for (const { path } of members) {
          sizes.set(path, metadata.get(path) ?? null);
        }
      } catch {
        // Optional metadata must not prevent review; keep this side unknown.
      }
    }),
  );
  return Object.fromEntries(sizes);
}
