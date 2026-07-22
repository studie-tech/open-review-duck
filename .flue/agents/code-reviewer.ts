import {
  type AgentRouteHandler,
  defineAgent,
  defineTool,
  registerProvider,
} from "@flue/runtime";
import * as v from "valibot";
import {
  REVIEWDUCK_AGENT_DESCRIPTION,
  REVIEWDUCK_TOOL_DESCRIPTIONS,
  reviewDuckAgentPrompt,
} from "../../src/config/prompts";

interface JobConfiguration {
  provider: string;
  model: string;
  apiProtocol:
    | "openai-responses"
    | "openai-completions"
    | "azure-openai-responses"
    | "anthropic-messages"
    | "google-generative-ai"
    | "google-vertex"
    | "mistral-conversations";
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  contextWindow: number;
  maxTokens: number;
  storeResponses: boolean;
  useManagedModels: boolean;
  jobKind: "explain" | "review";
  selectedUnit?: {
    path: string;
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    changedLineRanges: Array<{ startLine: number; endLine: number }>;
  };
  pullRequest: {
    title: string;
    description?: string;
    sourceBranch: string;
    targetBranch: string;
  };
}

/** Reads a required environment variable and fails fast when it is absent. */
function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Reads typed job data from the ReviewDuck control plane. */
async function controlPlane<T>(jobId: string, path: string): Promise<T> {
  const response = await fetch(
    `${requiredEnvironment("FLUE_CONTROL_PLANE_URL")}/api/internal/ai/jobs/${jobId}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${requiredEnvironment("FLUE_INTERNAL_SECRET")}`,
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Control plane returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/** Posts a typed payload to the ReviewDuck control plane. */
async function controlPlanePost<T>(
  jobId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(
    `${requiredEnvironment("FLUE_CONTROL_PLANE_URL")}/api/internal/ai/jobs/${jobId}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnvironment("FLUE_INTERNAL_SECRET")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Control plane returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/** Returns the default API base URL for a supported AI provider. */
function defaultBaseUrl(provider: string) {
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "google") return "https://generativelanguage.googleapis.com";
  if (provider === "mistral") return "https://api.mistral.ai/v1";
  return undefined;
}

export const description = REVIEWDUCK_AGENT_DESCRIPTION;

/** Dispatches the requested AI job operation inside the isolated agent runtime. */
export const route: AgentRouteHandler = async (context, next) => {
  const expected = requiredEnvironment("FLUE_INTERNAL_SECRET");
  if (context.req.header("authorization") !== `Bearer ${expected}`) {
    return context.json({ error: "Not found" }, 404);
  }
  await next();
};

export default defineAgent(async ({ id }) => {
  const configuration = await controlPlane<JobConfiguration>(id, "config");
  const providerId = configuration.useManagedModels
    ? configuration.provider
    : `job-${id.replaceAll("-", "")}`;
  if (!configuration.useManagedModels) {
    registerProvider(providerId, {
      api: configuration.apiProtocol,
      apiKey: configuration.apiKey,
      headers: configuration.headers,
      baseUrl: configuration.baseUrl ?? defaultBaseUrl(configuration.provider),
      contextWindow: configuration.contextWindow,
      maxTokens: configuration.maxTokens,
      storeResponses: configuration.storeResponses,
    });
  }

  const listFiles = defineTool({
    name: "list_review_files",
    description: REVIEWDUCK_TOOL_DESCRIPTIONS.listFiles,
    output: v.array(
      v.object({
        path: v.string(),
        symbols: v.array(v.string()),
        changeType: v.picklist(["added", "modified", "deleted", "renamed"]),
      }),
    ),
    run: () =>
      controlPlane<
        Array<{
          path: string;
          symbols: string[];
          changeType: "added" | "modified" | "deleted" | "renamed";
        }>
      >(id, "files"),
  });
  const readFile = defineTool({
    name: "read_review_file",
    description: REVIEWDUCK_TOOL_DESCRIPTIONS.readFile,
    input: v.object({ path: v.string() }),
    output: v.object({
      path: v.string(),
      changeType: v.picklist(["added", "modified", "deleted", "renamed"]),
      content: v.string(),
      previousContent: v.optional(v.string()),
    }),
    run: ({ input }) =>
      controlPlane<{
        path: string;
        changeType: "added" | "modified" | "deleted" | "renamed";
        content: string;
        previousContent?: string;
      }>(id, `files/${encodeURIComponent(input.path)}`),
  });
  const submitResult = defineTool({
    name: "submit_review_result",
    description: REVIEWDUCK_TOOL_DESCRIPTIONS.submitResult,
    input: v.object({
      summary: v.string(),
      annotations: v.array(
        v.object({
          title: v.string(),
          body: v.string(),
          path: v.string(),
          line: v.number(),
          endLine: v.optional(v.number()),
        }),
      ),
      findings: v.array(
        v.object({
          severity: v.picklist(["info", "warning", "critical"]),
          title: v.string(),
          body: v.string(),
          path: v.optional(v.string()),
          line: v.optional(v.number()),
        }),
      ),
    }),
    output: v.object({ accepted: v.boolean() }),
    run: ({ input }) =>
      controlPlanePost<{ accepted: boolean }>(id, "result", input),
  });

  return {
    model: `${providerId}/${configuration.model}`,
    thinkingLevel: configuration.jobKind === "review" ? "high" : "low",
    cwd: "/workspace",
    tools: [listFiles, readFile, submitResult],
    durability: { maxAttempts: 3, timeoutMs: 600_000 },
    instructions: reviewDuckAgentPrompt(configuration),
  };
});
