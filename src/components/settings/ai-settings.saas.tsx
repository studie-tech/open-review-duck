"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import { api, type RouterOutputs } from "~/trpc/react";

type Configuration = RouterOutputs["ai"]["configuration"];

/** Renders managed SaaS model preferences without credential inputs. */
export function SaasAiSettings({
  initialConfiguration,
}: {
  initialConfiguration: Configuration;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [mode, setMode] = useState(initialConfiguration.mode);
  const [model, setModel] = useState(initialConfiguration.managedModel);
  const [reviewPullRequests, setReviewPullRequests] = useState(
    initialConfiguration.reviewPullRequests,
  );
  const [disclosureAccepted, setDisclosureAccepted] = useState(
    initialConfiguration.disclosure.accepted,
  );
  const acceptDisclosure = api.ai.acceptBigPickleDisclosure.useMutation({
    onSuccess: () => {
      setDisclosureAccepted(true);
      void utils.ai.configuration.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const save = api.ai.saveConfiguration.useMutation({
    onSuccess: () => {
      void Promise.all([
        utils.ai.configuration.invalidate(),
        utils.workspace.guidance.invalidate(),
      ]);
      router.refresh();
      toast.success("AI preferences saved");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <PageContainer>
      <p className="text-violet text-xs font-semibold tracking-[.18em] uppercase">
        Optional assistant
      </p>
      <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em]">
        Managed AI with clear boundaries
      </h1>
      <p className="text-mist mt-2 max-w-2xl text-sm leading-6">
        SaaS uses service-owned models only. You never need to enter a model API
        key, provider token, or custom endpoint.
      </p>
      <section className="bg-surface/70 mt-9 grid gap-5 rounded-3xl border border-line p-6">
        <label className="text-mist grid gap-2 text-xs">
          Assistance timing
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
            className="bg-surface text-cloud h-11 rounded-xl border border-line px-4 text-sm outline-none"
          >
            <option value="off">Off</option>
            <option value="on_demand">On demand</option>
            <option value="automatic">
              Automatically review new revisions
            </option>
          </select>
        </label>
        <label className="text-mist grid gap-2 text-xs">
          Managed model
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="bg-surface text-cloud h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
          >
            {initialConfiguration.managedModels.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </label>
        {model === "big-pickle" && !disclosureAccepted && (
          <div className="border-violet/25 bg-violet/[.05] rounded-2xl border p-5">
            <p className="text-cloud text-sm font-medium">
              Big Pickle data disclosure
            </p>
            <p className="text-mist mt-2 text-xs leading-5">
              Free AI is limited to public repositories. Source snippets,
              prompts, tool results, and output are processed by OpenCode-hosted
              infrastructure in the US, may be used for model improvement, and
              are available free for a limited period.
            </p>
            <Button
              className="mt-4"
              variant="secondary"
              disabled={acceptDisclosure.isPending}
              onClick={() => acceptDisclosure.mutate()}
            >
              {acceptDisclosure.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Accept disclosure
            </Button>
          </div>
        )}
        <label className="bg-surface-subtle text-mist flex items-center justify-between gap-5 rounded-xl border border-line p-4 text-xs">
          <span>
            <span className="text-cloud block text-sm font-medium">
              Review the full pull request
            </span>
            <span className="mt-1 block">
              Request evidence-backed findings after a new revision syncs.
            </span>
          </span>
          <input
            type="checkbox"
            checked={reviewPullRequests}
            onChange={(event) => setReviewPullRequests(event.target.checked)}
            className="accent-lime size-4"
          />
        </label>
        <div className="flex justify-end">
          <Button
            disabled={
              save.isPending || (model === "big-pickle" && !disclosureAccepted)
            }
            onClick={() =>
              save.mutate({
                provider: model === "big-pickle" ? "opencode" : "openrouter",
                model,
                clearApiKey: false,
                clearHeaders: false,
                headers: {},
                useManagedModels: true,
                mode,
                reviewPullRequests,
              })
            }
          >
            {save.isPending && <Loader2 className="size-4 animate-spin" />}
            Save preferences
          </Button>
        </div>
      </section>
    </PageContainer>
  );
}
