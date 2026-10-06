import { PullRequestImport } from "~/components/review/pull-request-import";
import { protectApplicationRoute } from "~/server/auth";

/** Opens a provider PR link through the authenticated import workflow. */
export default async function PullRequestImportPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string | string[] }>;
}) {
  await protectApplicationRoute();
  const { url } = await searchParams;
  return (
    <PullRequestImport
      key={typeof url === "string" ? url : ""}
      url={typeof url === "string" ? url : ""}
    />
  );
}
