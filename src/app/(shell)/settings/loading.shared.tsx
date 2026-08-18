import { PageContainer } from "~/components/page-container";
import { Skeleton } from "~/components/ui/skeleton";

/** Shows the settings placeholder while a settings page loads. */
export default function SettingsLoading() {
  return (
    <PageContainer>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-4 h-10 w-56 max-w-full" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      <div className="mt-9 grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
      <div className="mt-4 space-y-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
    </PageContainer>
  );
}
