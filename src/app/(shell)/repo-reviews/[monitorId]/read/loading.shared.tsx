import { Skeleton } from "~/components/ui/skeleton";

/** Shows the focused repository reader's loading shell. */
export default function RepositoryReaderLoading() {
  return (
    <div className="flex h-screen bg-ink">
      <Skeleton className="h-full w-80 rounded-none" />
      <Skeleton className="m-5 h-[calc(100%-2.5rem)] flex-1 rounded-2xl" />
    </div>
  );
}
