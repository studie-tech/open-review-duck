import { notFound } from "next/navigation";
import { ReviewWorkspace } from "~/components/review/review-workspace";
import { isTrpcNotFoundError } from "~/lib/trpc-errors";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Renders the review page interface. */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ pullRequestId: string }>;
}) {
  await protectApplicationRoute();
  const { pullRequestId } = await params;
  const data = await api.review.workspace({ pullRequestId }).catch((cause) => {
    if (isTrpcNotFoundError(cause)) notFound();
    throw cause;
  });
  return (
    <ReviewWorkspace
      key={data.snapshot?.id ?? data.pullRequest.id}
      initialData={data}
    />
  );
}
