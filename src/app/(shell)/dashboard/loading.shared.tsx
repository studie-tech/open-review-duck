import { PageContainer } from "~/components/page-container";
import { Skeleton } from "~/components/ui/skeleton";

/** Shows the workspace overview placeholder while the dashboard loads. */
export default function DashboardLoading() {
  return (
    <PageContainer>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-end">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="mt-4 h-12 w-96 max-w-full" />
          <Skeleton className="mt-3 h-4 w-full" />
        </div>
        <Skeleton className="h-20 rounded-2xl" />
      </div>
      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-[29rem] rounded-3xl" />
        <Skeleton className="h-[29rem] rounded-3xl" />
      </div>
      <div className="mt-10 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="h-96 rounded-3xl" />
        <Skeleton className="h-80 rounded-3xl" />
      </div>
    </PageContainer>
  );
}
