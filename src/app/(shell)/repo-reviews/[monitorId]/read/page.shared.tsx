import { notFound } from "next/navigation";
import { RepositoryReader } from "~/components/repo-reviews/repository-reader";
import { isTrpcNotFoundError } from "~/lib/trpc-errors";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Opens the complete repository reading path for one monitored branch. */
export default async function RepositoryReadPage({
  params,
}: {
  params: Promise<{ monitorId: string }>;
}) {
  await protectApplicationRoute();
  const { monitorId } = await params;
  const monitor = await api.repoReviews.get({ monitorId }).catch((cause) => {
    if (isTrpcNotFoundError(cause)) notFound();
    throw cause;
  });
  const data = await api.review.workspace({
    pullRequestId: monitor.pullRequestId,
  });
  return <RepositoryReader initialData={data} monitor={monitor} />;
}
