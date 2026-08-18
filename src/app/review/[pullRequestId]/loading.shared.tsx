import { Skeleton } from "~/components/ui/skeleton";

/** Shows the review workspace placeholder while a pull request loads. */
export default function ReviewWorkspaceLoading() {
  return (
    <div className="bg-ink fixed inset-0 flex min-h-0 flex-col overflow-hidden">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line px-4 sm:px-6">
        <Skeleton className="size-9 rounded-full" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="mt-1.5 h-2.5 w-40 max-w-full" />
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-1.5 w-28 rounded-full" />
        </div>
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="size-9 rounded-full" />
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[300px_minmax(0,1fr)_320px]">
        <aside className="bg-panel hidden min-h-0 flex-col gap-3 border-r border-line p-4 2xl:flex">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9" />
          <div className="mt-2 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </aside>
        <section className="bg-code flex min-h-0 flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
            <div>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-1.5 h-2.5 w-56" />
            </div>
            <Skeleton className="h-7 w-20" />
          </div>
          <div className="flex-1 space-y-3 overflow-hidden p-5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="flex h-14 shrink-0 items-center justify-between border-t border-line px-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-9 w-32" />
          </div>
        </section>
        <aside className="bg-panel hidden min-h-0 flex-col gap-3 border-l border-line p-4 xl:flex">
          <Skeleton className="h-9" />
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </aside>
      </div>
    </div>
  );
}
