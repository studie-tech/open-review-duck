"use client";

import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  KeyRound,
  Loader2,
  PlugZap,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import { Button } from "~/components/ui/button";
import {
  type AiProviderPreset,
  aiProviderPresets,
  localDefaultAiPreset,
  matchingAiProviderPreset,
} from "~/lib/ai-provider-presets";
import { api, type RouterOutputs } from "~/trpc/react";
import type { AiProtocol } from "~/validators/ai";

type Configuration = RouterOutputs["ai"]["configuration"];

/** Parses and validates custom provider headers from JSON input. */
function parseHeaders(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      Object.values(parsed).some((item) => typeof item !== "string")
    ) {
      return null;
    }
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/** Renders and validates the managed-model and BYOK AI settings. */
export function LocalAiSettings({
  initialConfiguration,
}: {
  initialConfiguration: Configuration;
}) {
  const localMode = true;
  const router = useRouter();
  const utils = api.useUtils();
  const [managed, setManaged] = useState(
    !localMode ||
      (initialConfiguration.configuration?.useManagedModels ?? true),
  );
  const [mode, setMode] = useState(initialConfiguration.mode);
  const [reviewPullRequests, setReviewPullRequests] = useState(
    initialConfiguration.reviewPullRequests,
  );
  const [disclosureAccepted, setDisclosureAccepted] = useState(
    initialConfiguration.disclosure.accepted,
  );
  const configuredProvider =
    initialConfiguration.configuration?.provider ??
    (!localMode ? "openai" : localDefaultAiPreset.provider);
  const configuredPreset = matchingAiProviderPreset(configuredProvider);
  const [preset, setPreset] = useState<AiProviderPreset>(configuredPreset);
  const [provider, setProvider] = useState(configuredProvider);
  const [model, setModel] = useState(
    initialConfiguration.configuration?.model ??
      (!localMode
        ? initialConfiguration.managedModel
        : localDefaultAiPreset.model),
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(
    initialConfiguration.configuration?.baseUrl ??
      aiProviderPresets[configuredPreset].baseUrl,
  );
  const [apiProtocol, setApiProtocol] = useState<AiProtocol>(
    (initialConfiguration.configuration?.apiProtocol as
      | AiProtocol
      | undefined) ?? aiProviderPresets[configuredPreset].protocol,
  );
  const [contextWindow, setContextWindow] = useState(
    initialConfiguration.configuration?.contextWindow ?? 128_000,
  );
  const [maxTokens, setMaxTokens] = useState(
    initialConfiguration.configuration?.maxTokens ?? 8_000,
  );
  const [storeResponses, setStoreResponses] = useState(
    initialConfiguration.configuration?.storeResponses ?? false,
  );
  const [headers, setHeaders] = useState("{}");
  const parsedHeaders = parseHeaders(headers);
  const connectionFingerprint = JSON.stringify([
    provider,
    model,
    apiProtocol,
    apiKey,
    baseUrl,
    contextWindow,
    maxTokens,
    storeResponses,
    headers,
  ]);
  const [verification, setVerification] = useState<{
    fingerprint: string;
    token: string;
    latencyMs: number;
  } | null>(null);
  const [testFailure, setTestFailure] = useState<{
    fingerprint: string;
    message: string;
  } | null>(null);
  const isVerified = verification?.fingerprint === connectionFingerprint;
  const visibleFailure =
    testFailure?.fingerprint === connectionFingerprint ? testFailure : null;
  const hasStoredCredential =
    initialConfiguration.configuration?.provider === provider &&
    (initialConfiguration.configuration.hasApiKey ||
      initialConfiguration.configuration.hasHeaders);
  const byokIsValid =
    Boolean(model) &&
    Boolean(provider) &&
    parsedHeaders !== null &&
    Number.isFinite(contextWindow) &&
    Number.isFinite(maxTokens) &&
    (Object.keys(parsedHeaders ?? {}).length > 0 ||
      Boolean(apiKey) ||
      Boolean(hasStoredCredential));
  const testConnection = api.ai.testConfiguration.useMutation();
  const save = api.ai.saveConfiguration.useMutation({
    onSuccess: () => {
      setApiKey("");
      setVerification(null);
      void Promise.all([
        utils.ai.configuration.invalidate(),
        utils.workspace.guidance.invalidate(),
      ]);
      router.refresh();
      toast.success("AI configuration saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const acceptDisclosure = api.ai.acceptBigPickleDisclosure.useMutation({
    onSuccess: () => {
      setDisclosureAccepted(true);
      void utils.ai.configuration.invalidate();
      toast.success("Big Pickle disclosure accepted");
    },
    onError: (error) => toast.error(error.message),
  });

  /** Builds the current BYOK configuration from the settings form. */
  const byokInput = () => ({
    provider,
    model,
    apiProtocol,
    apiKey: apiKey || undefined,
    headers: parsedHeaders ?? {},
    baseUrl: baseUrl || undefined,
    contextWindow,
    maxTokens,
    storeResponses,
    useManagedModels: false as const,
    mode,
    reviewPullRequests,
  });

  /** Tests the current model configuration and stores its verification proof. */
  const handleTestConnection = async () => {
    const fingerprint = connectionFingerprint;
    setTestFailure(null);
    try {
      const result = await testConnection.mutateAsync(byokInput());
      if (!result.ok) {
        setVerification(null);
        setTestFailure({ fingerprint, message: result.error });
        return;
      }
      setVerification({
        fingerprint,
        token: result.verificationToken,
        latencyMs: 0,
      });
      toast.success("Agent workflow verified");
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Model workflow test failed";
      setVerification(null);
      setTestFailure({ fingerprint, message });
    }
  };

  return (
    <PageContainer>
      <p className="text-violet text-xs font-semibold tracking-[.18em] uppercase">
        Optional assistant
      </p>
      <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em]">
        AI that supports your judgment
      </h1>
      <p className="text-mist mt-2 max-w-2xl text-sm leading-6">
        Explanations and reviews run in a scoped, isolated workspace. Source
        files are treated as untrusted input and provider credentials are only
        used for model requests.
      </p>

      {localMode && (
        <div className="mt-9 grid gap-4 sm:grid-cols-2">
          {[
            {
              value: true,
              title: "Built-in Big Pickle",
              detail: "No account or API key · privacy disclosure required",
              icon: Sparkles,
            },
            {
              value: false,
              title: "Local or BYOK model",
              detail:
                "Ollama, a local endpoint, or your encrypted provider key",
              icon: KeyRound,
            },
          ].map(({ value, title, detail, icon: Icon }) => (
            <button
              type="button"
              key={title}
              onClick={() => setManaged(value)}
              className={`rounded-2xl border p-5 text-left transition ${
                managed === value
                  ? "border-violet/35 bg-violet/[.06]"
                  : "bg-surface/70 border-line"
              }`}
            >
              <div className="flex items-center justify-between">
                <Icon className="text-violet size-5" />
                {managed === value && <Check className="text-violet size-4" />}
              </div>
              <p className="mt-5 text-sm font-medium">{title}</p>
              <p className="text-mist mt-2 text-xs leading-5">{detail}</p>
            </button>
          ))}
        </div>
      )}

      <section
        className={`bg-surface/70 grid gap-5 rounded-3xl border border-line p-6 ${localMode ? "mt-6" : "mt-9"}`}
      >
        <label
          htmlFor="ai-assistance-timing"
          className="text-mist grid gap-2 text-xs"
        >
          Assistance timing
          <select
            id="ai-assistance-timing"
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as "off" | "on_demand" | "automatic")
            }
            className="bg-surface text-cloud h-11 rounded-xl border border-line px-4 text-sm outline-none"
          >
            <option value="off">Off</option>
            <option value="on_demand">On demand</option>
            <option value="automatic">Automatically explain each unit</option>
          </select>
        </label>
        {managed &&
          initialConfiguration.managedModel === "big-pickle" &&
          !disclosureAccepted && (
            <div className="border-violet/25 bg-violet/[.05] rounded-2xl border p-5">
              <p className="text-cloud text-sm font-medium">
                Big Pickle data disclosure
              </p>
              <p className="text-mist mt-2 text-xs leading-5">
                Internet access is required. Source snippets, prompts, tool
                results, and output are sent to OpenCode-hosted infrastructure
                in the US. Access is free for a limited period and submitted
                data may be used to improve the model. Confirm that you have
                authority to submit this repository.
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
              Ask the assistant for evidence-backed findings when a new revision
              syncs.
            </span>
          </span>
          <input
            type="checkbox"
            checked={reviewPullRequests}
            onChange={(event) => setReviewPullRequests(event.target.checked)}
            className="accent-lime size-4"
          />
        </label>
        {!managed && (
          <label className="text-mist grid gap-2 text-xs">
            Provider
            <select
              value={preset}
              onChange={(event) => {
                const next = event.target.value as AiProviderPreset;
                const defaults = aiProviderPresets[next];
                setPreset(next);
                setProvider(next === "custom" ? "" : next);
                setApiProtocol(defaults.protocol);
                setBaseUrl(defaults.baseUrl);
                setModel(
                  "defaultModel" in defaults ? defaults.defaultModel : "",
                );
              }}
              className="bg-surface text-cloud h-11 rounded-xl border border-line px-4 text-sm outline-none"
            >
              {Object.entries(aiProviderPresets).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {!managed && preset === "custom" && (
          <label className="text-mist grid gap-2 text-xs">
            Provider ID
            <input
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="my-provider"
              className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
            />
          </label>
        )}
        {!managed && preset === "opencode" && (
          <div className="border-violet/20 bg-violet/[.045] rounded-2xl border p-4 text-xs leading-5 sm:p-5">
            <p className="text-cloud font-medium">
              Big Pickle · limited free access
            </p>
            <p className="text-mist mt-1.5">
              OpenCode currently offers Big Pickle free for a limited time and
              requires an OpenCode Zen API key. During the free period,
              submitted code may be collected to improve the model. Avoid this
              preset for confidential repositories unless that data use is
              acceptable to you.
            </p>
            <a
              href="https://opencode.ai/docs/zen"
              target="_blank"
              rel="noreferrer"
              className="text-violet mt-2 inline-flex font-medium hover:underline"
            >
              Review OpenCode Zen terms and create a key
            </a>
          </div>
        )}
        <label
          htmlFor="ai-provider-model"
          className="text-mist grid gap-2 text-xs"
        >
          {managed ? "Managed model" : "Model"}
          {managed && initialConfiguration.managedModels.length > 1 ? (
            <select
              id="ai-provider-model"
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
          ) : (
            <input
              id="ai-provider-model"
              value={managed ? initialConfiguration.managedModel : model}
              onChange={(event) => setModel(event.target.value)}
              readOnly={managed}
              className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
            />
          )}
        </label>
        {!managed && (
          <>
            <label className="text-mist grid gap-2 text-xs">
              Base URL
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://provider.example.com/v1"
                className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-4 text-sm outline-none"
              />
            </label>
            <details className="group rounded-2xl border border-line">
              <summary className="focus-visible:ring-violet/50 flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-4 py-3.5 outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
                <span>
                  <span className="text-cloud block text-sm font-medium">
                    Advanced settings
                  </span>
                  <span className="text-mist mt-0.5 block text-xs leading-5">
                    Protocol, token limits, headers, and response storage
                  </span>
                </span>
                <ChevronDown className="text-mist size-4 shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
                <label className="text-mist grid gap-2 text-xs sm:col-span-2">
                  API protocol
                  <select
                    value={apiProtocol}
                    onChange={(event) =>
                      setApiProtocol(event.target.value as AiProtocol)
                    }
                    className="bg-surface text-cloud h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
                  >
                    <option value="openai-responses">OpenAI Responses</option>
                    <option value="openai-completions">
                      OpenAI Chat Completions
                    </option>
                    <option value="azure-openai-responses">
                      Azure OpenAI Responses
                    </option>
                    <option value="anthropic-messages">
                      Anthropic Messages
                    </option>
                    <option value="google-generative-ai">
                      Google Generative AI
                    </option>
                    <option value="google-vertex">Google Vertex AI</option>
                    <option value="mistral-conversations">
                      Mistral Conversations
                    </option>
                  </select>
                </label>
                <label className="text-mist grid gap-2 text-xs">
                  Context window
                  <input
                    type="number"
                    min={1024}
                    value={contextWindow}
                    onChange={(event) =>
                      setContextWindow(event.target.valueAsNumber)
                    }
                    className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
                  />
                </label>
                <label className="text-mist grid gap-2 text-xs">
                  Maximum output tokens
                  <input
                    type="number"
                    min={16}
                    value={maxTokens}
                    onChange={(event) =>
                      setMaxTokens(event.target.valueAsNumber)
                    }
                    className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
                  />
                </label>
                <label className="text-mist grid gap-2 text-xs sm:col-span-2">
                  Custom headers (JSON)
                  <textarea
                    rows={4}
                    spellCheck={false}
                    value={headers}
                    onChange={(event) => setHeaders(event.target.value)}
                    placeholder={'{"api-key":"…","x-provider-version":"…"}'}
                    className="bg-surface text-cloud focus:border-violet/40 rounded-xl border border-line px-4 py-3 font-mono text-xs outline-none"
                  />
                  {parsedHeaders === null && (
                    <span className="text-red-700 dark:text-red-300">
                      Enter a JSON object containing string values.
                    </span>
                  )}
                  {initialConfiguration.configuration?.hasHeaders && (
                    <span className="text-lime">
                      Encrypted headers are already stored. Leave {"{}"} to keep
                      them.
                    </span>
                  )}
                </label>
                <label className="bg-surface-subtle text-mist flex items-center justify-between gap-4 rounded-xl border border-line p-4 text-xs sm:col-span-2">
                  <span>
                    <span className="text-cloud block text-sm font-medium">
                      Provider-side response storage
                    </span>
                    <span className="mt-1 block">
                      Only enable this when the selected Responses API requires
                      provider-side item persistence.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={storeResponses}
                    onChange={(event) =>
                      setStoreResponses(event.target.checked)
                    }
                    className="accent-violet size-4"
                  />
                </label>
              </div>
            </details>
            <label className="text-mist grid gap-2 text-xs">
              API key{" "}
              {initialConfiguration.configuration?.provider === provider &&
                initialConfiguration.configuration.hasApiKey && (
                  <span className="text-lime">A key is already stored</span>
                )}
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  initialConfiguration.configuration?.provider === provider &&
                  initialConfiguration.configuration.hasApiKey
                    ? "Leave blank to keep current key"
                    : undefined
                }
                className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
              />
            </label>
          </>
        )}
        {!managed ? (
          <div className="bg-surface-subtle grid gap-4 rounded-2xl border border-line p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5">
            <div className="flex min-w-0 items-start gap-3" aria-live="polite">
              {testConnection.isPending ? (
                <Loader2 className="text-violet mt-0.5 size-5 shrink-0 animate-spin" />
              ) : isVerified ? (
                <CircleCheck className="text-lime mt-0.5 size-5 shrink-0" />
              ) : visibleFailure ? (
                <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-700 dark:text-red-300" />
              ) : (
                <PlugZap className="text-mist mt-0.5 size-5 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-cloud text-sm font-medium">
                  {testConnection.isPending
                    ? "Testing the agent workflow…"
                    : isVerified
                      ? "Agent workflow verified"
                      : visibleFailure
                        ? "Model workflow test failed"
                        : "Model workflow test required"}
                </p>
                <p
                  className={`mt-1 text-xs leading-5 ${
                    visibleFailure
                      ? "text-red-700 dark:text-red-300"
                      : "text-mist"
                  }`}
                >
                  {testConnection.isPending
                    ? "Running a short multi-step tool workflow against this exact model configuration."
                    : isVerified
                      ? `Completed a multi-step tool run in ${verification.latencyMs.toLocaleString()} ms. This exact configuration can now be selected.`
                      : visibleFailure?.message ||
                        "Test tool calling, structured arguments, and follow-up generation before using this configuration for reviews."}
                </p>
              </div>
            </div>
            <div className="grid gap-2 sm:flex sm:justify-end">
              <Button
                variant="secondary"
                className="w-full sm:w-auto"
                disabled={
                  !byokIsValid || testConnection.isPending || save.isPending
                }
                onClick={handleTestConnection}
              >
                {testConnection.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PlugZap className="size-4" />
                )}
                {isVerified ? "Test again" : "Test model workflow"}
              </Button>
              <Button
                className="w-full sm:w-auto"
                disabled={!byokIsValid || !isVerified || save.isPending}
                onClick={() =>
                  save.mutate({
                    ...byokInput(),
                    verificationToken: verification?.token,
                  })
                }
              >
                {save.isPending && <Loader2 className="size-4 animate-spin" />}
                Save & use model
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              disabled={
                save.isPending ||
                (initialConfiguration.managedModel === "big-pickle" &&
                  !disclosureAccepted)
              }
              onClick={() =>
                save.mutate({
                  provider: "openai",
                  model,
                  apiProtocol,
                  headers: {},
                  contextWindow,
                  maxTokens,
                  storeResponses,
                  useManagedModels: true,
                  mode,
                  reviewPullRequests,
                })
              }
            >
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              Save configuration
            </Button>
          </div>
        )}
      </section>
    </PageContainer>
  );
}
