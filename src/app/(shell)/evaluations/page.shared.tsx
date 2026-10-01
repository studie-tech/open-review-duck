import { Evaluations } from "~/components/evaluations/evaluations";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Gates the evaluation workspace before any dataset or prompt is loaded. */
export default async function EvaluationsPage({
  searchParams,
}: {
  searchParams: Promise<{ finding?: string }>;
}) {
  await protectApplicationRoute();
  const access = await api.evaluations.access();
  if (!access.allowed)
    return (
      <div className="p-10">
        <h1 className="text-cloud text-2xl font-semibold">
          Administrator access required
        </h1>
        <p className="text-mist mt-3">
          Evaluation datasets are available to platform administrators on SaaS
          and everyone in local installations.
        </p>
      </div>
    );
  return <Evaluations findingId={(await searchParams).finding} />;
}
