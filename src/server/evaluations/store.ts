import type { AiPromptKey } from "~/config/ai-prompt-catalog";
import type { EvalCase, EvalOutput } from "~/lib/evaluations";
import { openVaultSecret, sealVaultSecret } from "~/server/security/vault";

export interface EvalSnapshot {
  version: 1;
  mode: "discovery" | "verification";
  split: "development" | "holdout";
  provider: string;
  model: string;
  prompts: Record<AiPromptKey, string>;
  cases: (EvalCase & { id: string })[];
}

/** Seals evaluation source, prompts and outputs with tenant-bound encryption. */
export function sealEval(
  workspaceId: string,
  recordId: string,
  value: unknown,
) {
  return sealVaultSecret(
    { workspaceId, recordId, provider: "evaluation" },
    JSON.stringify(value),
  );
}

/** Opens a previously validated evaluation record within its owning workspace. */
export async function openEval<T extends EvalCase | EvalSnapshot | EvalOutput>(
  workspaceId: string,
  recordId: string,
  value: string,
): Promise<T> {
  return JSON.parse(
    await openVaultSecret(
      { workspaceId, recordId, provider: "evaluation" },
      value,
    ),
  ) as T;
}
