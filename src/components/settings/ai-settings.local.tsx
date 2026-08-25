"use client";

import { CircleAlert, CircleCheck, Loader2, PlugZap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import { AiPromptEditor } from "~/components/settings/ai-prompt-editor";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  type AiProviderPreset,
  aiProviderPresets,
  matchingAiProviderPreset,
} from "~/lib/ai-provider-presets";
import { parseOptionalReviewTokenCap } from "~/lib/token-usage";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

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
  const router = useRouter();
  const utils = api.useUtils();
  const [mode, setMode] = useState(initialConfiguration.mode);
  const [reviewPullRequests, setReviewPullRequests] = useState(
    initialConfiguration.reviewPullRequests,
  );
  const [maxReviewTokensInput, setMaxReviewTokensInput] = useState(
    initialConfiguration.maxReviewTokens?.toString() ?? "",
  );
  const maxReviewTokensField =
    parseOptionalReviewTokenCap(maxReviewTokensInput);
  const deepReviewAvailable = initialConfiguration.deepReviewAvailable;
  const savedConfiguration = initialConfiguration.configuration;
  const configuredPreset = savedConfiguration
    ? matchingAiProviderPreset(savedConfiguration.provider)
    : "";
  const [preset, setPreset] = useState<AiProviderPreset | "">(configuredPreset);
  const [provider, setProvider] = useState(savedConfiguration?.provider ?? "");
  const [model, setModel] = useState(savedConfiguration?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(
    savedConfiguration?.baseUrl ??
      (configuredPreset ? aiProviderPresets[configuredPreset].baseUrl : ""),
  );
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [headers, setHeaders] = useState("{}");
  const parsedHeaders = parseHeaders(headers);
  const hasStoredApiKey = Boolean(
    initialConfiguration.configuration?.provider === provider &&
      initialConfiguration.configuration.hasApiKey,
  );
  const hasStoredHeaders = Boolean(
    initialConfiguration.configuration?.provider === provider &&
      initialConfiguration.configuration.hasHeaders,
  );
  const connectionFingerprint = JSON.stringify([
    provider,
    model,
    apiKey,
    baseUrl,
    clearApiKey,
    clearHeaders,
    headers,
  ]);
  const [verification, setVerification] = useState<{
    fingerprint: string;
    latencyMs: number;
  } | null>(null);
  const [testFailure, setTestFailure] = useState<{
    fingerprint: string;
    message: string;
  } | null>(null);
  const isVerified = verification?.fingerprint === connectionFingerprint;
  const visibleFailure =
    testFailure?.fingerprint === connectionFingerprint ? testFailure : null;
  const byokIsValid =
    Boolean(model) &&
    Boolean(provider) &&
    Boolean(baseUrl) &&
    parsedHeaders !== null;
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

  /** Builds the current BYOK configuration from the settings form. */
  const byokInput = () => ({
    provider,
    model,
    apiKey: apiKey || undefined,
    clearApiKey,
    clearHeaders,
    headers: parsedHeaders ?? {},
    baseUrl: baseUrl || undefined,
    useManagedModels: false as const,
    mode,
    reviewPullRequests,
    maxReviewTokens: maxReviewTokensField.cap,
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
        latencyMs: result.latencyMs,
      });
      toast.success("Provider connection verified");
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Model workflow test failed";
      setVerification(null);
      setTestFailure({ fingerprint, message });
    }
  };

  const savedPresetLabel = savedConfiguration
    ? aiProviderPresets[matchingAiProviderPreset(savedConfiguration.provider)]
        .label
    : null;
  const canTest = byokIsValid && !testConnection.isPending && !save.isPending;
  const canSave =
    byokIsValid && isVerified && maxReviewTokensField.valid && !save.isPending;

  return (
    <PageContainer>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <p className="text-violet text-xs font-semibold tracking-[.18em] uppercase">
            AI assistant
          </p>
          <h1 className="font-editorial mt-2 text-3xl font-medium tracking-[-.04em] sm:text-4xl">
            AI that supports your judgment
          </h1>
          <p className="text-mist mt-2 max-w-2xl text-sm leading-6">
            Explanations and reviews run in a scoped, isolated workspace. Source
            files are treated as untrusted input and provider credentials are
            only used for model requests.
          </p>
        </div>
        {savedConfiguration ? (
          <Badge className="border-violet/25 bg-violet/10 text-violet w-fit">
            {savedPresetLabel} · {savedConfiguration.model}
          </Badge>
        ) : (
          <Badge className="w-fit">No provider saved</Badge>
        )}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <section
          aria-labelledby="ai-connection-status-heading"
          className="bg-surface/70 flex min-w-0 flex-col rounded-2xl border border-line p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2
                id="ai-connection-status-heading"
                className="text-mist text-xs font-medium tracking-wide uppercase"
              >
                Provider status
              </h2>
              <p className="text-fog mt-2 text-xs leading-5">
                ReviewDuck checks the endpoint, credentials, and selected model
                without spending inference tokens.
              </p>
            </div>
            {savedConfiguration && (
              <Badge
                className={
                  isVerified ? "border-lime/25 bg-lime/10 text-lime" : undefined
                }
              >
                {isVerified ? "Verified" : "Saved"}
              </Badge>
            )}
          </div>
          <div className="mt-5 flex items-start gap-3" aria-live="polite">
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
              <p className="text-lg font-semibold tracking-tight sm:text-xl">
                {testConnection.isPending
                  ? "Checking provider access…"
                  : isVerified
                    ? "Connection verified"
                    : visibleFailure
                      ? "Connection failed"
                      : savedConfiguration
                        ? "Test required to save changes"
                        : "No provider connected"}
              </p>
              <p
                className={`mt-1 text-xs leading-5 ${
                  visibleFailure
                    ? "text-red-700 dark:text-red-300"
                    : "text-mist"
                }`}
              >
                {testConnection.isPending
                  ? "Checking authentication and confirming that the selected model is available."
                  : isVerified
                    ? `Authenticated and found the selected model in ${verification.latencyMs.toLocaleString()} ms.`
                    : visibleFailure?.message ||
                      (savedConfiguration
                        ? `${savedPresetLabel} is saved. Test the current settings before saving again.`
                        : "Choose a provider below, then test the connection.")}
              </p>
            </div>
          </div>
          {savedConfiguration && (
            <dl className="mt-5 grid gap-3 text-xs sm:grid-cols-2">
              <div className="bg-surface-subtle min-w-0 rounded-xl border border-line px-3 py-2.5">
                <dt className="text-fog">Endpoint</dt>
                <dd className="text-cloud mt-1 truncate font-mono">
                  {savedConfiguration.baseUrl || "Not set"}
                </dd>
              </div>
              <div className="bg-surface-subtle min-w-0 rounded-xl border border-line px-3 py-2.5">
                <dt className="text-fog">Credentials</dt>
                <dd className="text-cloud mt-1">
                  {savedConfiguration.hasApiKey
                    ? "API key stored"
                    : "No API key stored"}
                  {savedConfiguration.hasHeaders ? " · headers stored" : ""}
                </dd>
              </div>
            </dl>
          )}
        </section>

        <section
          aria-labelledby="ai-preferences-heading"
          className="bg-surface/70 overflow-hidden rounded-2xl border border-line"
        >
          <div className="border-b border-line px-5 py-5 sm:px-6">
            <h2 id="ai-preferences-heading" className="text-base font-medium">
              Assistant preferences
            </h2>
            <p className="text-mist mt-1 text-xs leading-5">
              Choose when ReviewDuck should call your provider. These save with
              the connection below.
            </p>
          </div>
          <div className="divide-y divide-line">
            <div className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,16rem)] sm:items-center sm:gap-6 sm:px-6">
              <label htmlFor="ai-assistance-timing" className="min-w-0">
                <span className="text-cloud block text-sm font-medium">
                  Assistance timing
                </span>
                <span className="text-mist mt-1 block text-xs leading-5">
                  Off, on demand, or automatic explanations for each review
                  unit.
                </span>
              </label>
              <select
                id="ai-assistance-timing"
                value={mode}
                onChange={(event) =>
                  setMode(
                    event.target.value as "off" | "on_demand" | "automatic",
                  )
                }
                className="bg-surface text-cloud focus:border-violet/40 h-11 w-full rounded-xl border border-line px-3 text-sm outline-none"
              >
                <option value="off">Off</option>
                <option value="on_demand">On demand</option>
                <option value="automatic">Automatic</option>
              </select>
            </div>
            <div
              className={cn(
                "grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6 sm:px-6",
                !deepReviewAvailable && "bg-surface-subtle/60",
              )}
            >
              <div className="min-w-0">
                <p className="text-cloud text-sm font-medium">
                  Review the full pull request
                </p>
                <p className="text-mist mt-1 text-xs leading-5">
                  {deepReviewAvailable
                    ? "Ask the assistant for evidence-backed findings when a new revision syncs. One agent runs per changed file."
                    : "This deployment cannot run a pull-request review."}
                </p>
              </div>
              <label className="inline-flex shrink-0 items-center gap-2 sm:mt-0.5">
                <span className="sr-only">Review the full pull request</span>
                <span className="relative inline-flex">
                  <input
                    type="checkbox"
                    checked={reviewPullRequests}
                    // The appliance always satisfies the gate today, but
                    // reading the flag rather than hardcoding `true` keeps
                    // entitlement expressed in exactly one place.
                    disabled={!deepReviewAvailable}
                    onChange={(event) =>
                      setReviewPullRequests(event.target.checked)
                    }
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="bg-surface-subtle peer-checked:bg-lime peer-focus-visible:ring-lime/55 peer-disabled:opacity-45 block h-6 w-10 rounded-full border border-line transition peer-checked:border-lime peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-ink peer-disabled:cursor-not-allowed"
                  />
                  <span
                    aria-hidden="true"
                    className="bg-cloud pointer-events-none absolute top-0.5 left-0.5 size-5 rounded-full shadow-sm transition peer-checked:translate-x-4 peer-checked:bg-accent-foreground peer-disabled:opacity-45"
                  />
                </span>
              </label>
            </div>
            <div className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,16rem)] sm:items-center sm:gap-6 sm:px-6">
              <label htmlFor="ai-review-token-cap" className="min-w-0">
                <span className="text-cloud block text-sm font-medium">
                  Tokens per review
                </span>
                <span className="text-mist mt-1 block text-xs leading-5">
                  Optional cap on one review. Leave empty for no limit.
                </span>
              </label>
              <div className="min-w-0">
                <input
                  id="ai-review-token-cap"
                  inputMode="numeric"
                  value={maxReviewTokensInput}
                  placeholder="No limit"
                  onChange={(event) =>
                    setMaxReviewTokensInput(event.target.value)
                  }
                  className="bg-surface text-cloud focus:border-violet/40 h-11 w-full rounded-xl border border-line px-3 text-sm outline-none"
                />
                {!maxReviewTokensField.valid && (
                  <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                    Enter a whole number of tokens, or leave this empty.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <section
        aria-labelledby="ai-provider-heading"
        className="bg-surface/70 mt-4 overflow-hidden rounded-2xl border border-line"
      >
        <div className="border-b border-line px-5 py-5 sm:px-6">
          <h2 id="ai-provider-heading" className="text-base font-medium">
            Model provider
          </h2>
          <p className="text-mist mt-1 max-w-2xl text-xs leading-5">
            Connect a local model or your own hosted endpoint. Test the
            connection before ReviewDuck will use it.
          </p>
        </div>
        <div className="grid gap-5 px-5 py-5 sm:grid-cols-2 sm:gap-6 sm:px-6">
          <label className="grid gap-2">
            <span className="text-cloud text-sm font-medium">Provider</span>
            <select
              value={preset}
              onChange={(event) => {
                const next = event.target.value as AiProviderPreset | "";
                if (!next) {
                  setPreset("");
                  setProvider("");
                  setBaseUrl("");
                  setModel("");
                  setApiKey("");
                  setHeaders("{}");
                  setClearApiKey(false);
                  setClearHeaders(false);
                  return;
                }
                const defaults = aiProviderPresets[next];
                setPreset(next);
                setProvider(next === "custom" ? "" : next);
                setBaseUrl(defaults.baseUrl);
                setModel("");
                setApiKey("");
                setHeaders("{}");
                setClearApiKey(false);
                setClearHeaders(false);
              }}
              className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-3 text-sm outline-none"
            >
              <option value="">Select a provider</option>
              {Object.entries(aiProviderPresets).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {preset === "custom" ? (
            <label className="grid gap-2">
              <span className="text-cloud text-sm font-medium">
                Provider ID
              </span>
              <input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                placeholder="my-provider"
                className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-3 font-mono text-sm outline-none"
              />
            </label>
          ) : (
            <label htmlFor="ai-provider-model" className="grid gap-2">
              <span className="text-cloud text-sm font-medium">Model</span>
              <input
                id="ai-provider-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-3 font-mono text-sm outline-none"
              />
            </label>
          )}
          {preset === "custom" && (
            <label htmlFor="ai-provider-model" className="grid gap-2">
              <span className="text-cloud text-sm font-medium">Model</span>
              <input
                id="ai-provider-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-3 font-mono text-sm outline-none"
              />
            </label>
          )}
          <label className="grid gap-2">
            <span className="text-cloud text-sm font-medium">Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://provider.example.com/v1"
              className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-3 text-sm outline-none"
            />
          </label>
          <label className="grid gap-2">
            <span className="text-cloud flex flex-wrap items-center gap-2 text-sm font-medium">
              API key
              {hasStoredApiKey && (
                <span className="text-lime text-xs font-normal">
                  A key is already stored
                </span>
              )}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setClearApiKey(false);
              }}
              placeholder={
                hasStoredApiKey ? "Leave blank to keep current key" : undefined
              }
              className="bg-surface text-cloud focus:border-violet/40 h-11 rounded-xl border border-line px-3 font-mono text-sm outline-none"
            />
            {hasStoredApiKey && (
              <span className="text-mist flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={clearApiKey}
                  onChange={(event) => setClearApiKey(event.target.checked)}
                  className="accent-violet size-4"
                />
                Remove the stored key when saving
              </span>
            )}
          </label>
        </div>
        <details className="border-t border-line px-5 py-5 sm:px-6">
          <summary className="text-cloud cursor-pointer text-sm font-medium">
            Advanced headers
          </summary>
          <label className="mt-4 grid gap-2">
            <span className="text-mist text-xs leading-5">
              Optional JSON object of string headers. Leave {"{}"} to keep any
              encrypted headers already stored.
            </span>
            <textarea
              rows={4}
              spellCheck={false}
              value={headers}
              onChange={(event) => {
                setHeaders(event.target.value);
                setClearHeaders(false);
              }}
              placeholder={'{"api-key":"…","x-provider-version":"…"}'}
              className="bg-surface text-cloud focus:border-violet/40 rounded-xl border border-line px-3 py-3 font-mono text-xs outline-none"
            />
            {parsedHeaders === null && (
              <span className="text-xs text-red-700 dark:text-red-300">
                Enter a JSON object containing string values.
              </span>
            )}
            {hasStoredHeaders && (
              <span className="text-mist flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={clearHeaders}
                  onChange={(event) => setClearHeaders(event.target.checked)}
                  className="accent-violet size-4"
                />
                Remove the stored headers when saving
              </span>
            )}
          </label>
        </details>
        <div className="border-t border-line px-5 py-4 sm:flex sm:justify-end sm:gap-2 sm:px-6">
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            disabled={!canTest}
            onClick={handleTestConnection}
          >
            {testConnection.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PlugZap className="size-4" />
            )}
            {isVerified ? "Test again" : "Test connection"}
          </Button>
          <Button
            className="mt-2 w-full sm:mt-0 sm:w-auto"
            variant={isVerified ? "primary" : "secondary"}
            disabled={!canSave}
            onClick={() => save.mutate(byokInput())}
          >
            {save.isPending && <Loader2 className="size-4 animate-spin" />}
            Save & use model
          </Button>
        </div>
      </section>
      {initialConfiguration.canEditPrompts && <AiPromptEditor />}
    </PageContainer>
  );
}
