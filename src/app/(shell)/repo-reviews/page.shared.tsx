import { RepoReviewsContent } from "~/components/repo-reviews/repo-reviews-content";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Renders the monitored-repository cockpit. */
export default async function RepoReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ monitor?: string | string[] }>;
}) {
  await protectApplicationRoute();
  const monitor = (await searchParams).monitor;
  const [evaluationAccess, monitors, repositories] = await Promise.all([
    api.evaluations.access(),
    api.repoReviews.list(),
    api.provider.listImportedRepositories(),
  ]);
  return (
    <RepoReviewsContent
      canEvaluate={evaluationAccess.allowed}
      initialMonitors={monitors}
      initialRepositories={repositories}
      initialMonitorId={typeof monitor === "string" ? monitor : undefined}
      fetchedAt={Date.now()}
    />
  );
}
