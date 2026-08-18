import { BrandMark } from "~/components/brand-mark";

/** Shows an immediate full-page placeholder while a section loads. */
export default function RootLoading() {
  return (
    <div className="bg-ink grid min-h-screen place-items-center">
      <div className="flex animate-pulse flex-col items-center gap-4">
        <BrandMark className="size-12" />
        <span className="text-mist text-sm">Loading…</span>
      </div>
    </div>
  );
}
