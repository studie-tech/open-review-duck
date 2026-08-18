import { PageContainer } from "~/components/page-container";
import { Skeleton } from "~/components/ui/skeleton";

/** Shows the review inbox placeholder while the dashboard loads. */
export default function DashboardLoading() {
  return (
    <PageContainer>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div className="w-full max-w-xl">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-4 h-9 w-80 max-w-full" />
          <Skeleton className="mt-3 h-4 w-full" />
        </div>
        <Skeleton className="h-11 w-40 shrink-0" />
      </div>
      <div className="mt-8 flex flex-wrap gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="mt-6 space-y-3">
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-20 rounded-2xl" />
        <Skeleton className="h-20 rounded-2xl" />
      </div>
    </PageContainer>
  );
}
