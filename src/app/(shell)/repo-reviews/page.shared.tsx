import { RepoReviewsContent } from "~/components/repo-reviews/repo-reviews-content";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Renders the monitored-repository cockpit. */
export default async function RepoReviewsPage() {
  await protectApplicationRoute();
  const [monitors, repositories] = await Promise.all([
    api.repoReviews.list(),
    api.provider.listImportedRepositories(),
  ]);
  return (
    <RepoReviewsContent
      initialMonitors={monitors}
      initialRepositories={repositories}
    />
  );
}
