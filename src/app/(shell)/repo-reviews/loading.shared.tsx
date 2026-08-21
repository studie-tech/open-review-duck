import { PageContainer } from "~/components/page-container";
import { Skeleton } from "~/components/ui/skeleton";

/** Shows the repository cockpit's loading shell. */
export default function RepoReviewsLoading() {
  return (
    <PageContainer className="mx-auto max-w-[1600px]">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="mt-3 h-5 w-[32rem] max-w-full" />
      <Skeleton className="mt-8 h-[680px] rounded-3xl" />
    </PageContainer>
  );
}
