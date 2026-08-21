import { PullRequestsContent } from "~/components/dashboard/dashboard-content";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Renders the pull request review inbox. */
export default async function PullRequestsPage() {
  await protectApplicationRoute();
  return (
    <PullRequestsContent initialPullRequests={await api.review.dashboard()} />
  );
}
