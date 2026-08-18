import { PageContainer } from "~/components/page-container";
import { Skeleton } from "~/components/ui/skeleton";

/** Shows the achievements placeholder while gamification data loads. */
export default function AchievementsLoading() {
  return (
    <PageContainer>
      <Skeleton className="h-3 w-28" />
      <Skeleton className="mt-4 h-9 w-72 max-w-full" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
      </div>
    </PageContainer>
  );
}
