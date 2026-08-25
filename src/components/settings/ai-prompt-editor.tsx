"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  AI_PROMPT_FLOWS,
  type AiPromptFlow,
  type AiPromptFlowId,
  type AiPromptFlowNode,
} from "~/config/ai-prompt-flows";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type PromptRecord = RouterOutputs["ai"]["prompts"][number];

/** Lets an administrator edit the seeded model prompts for this deployment. */
export function AiPromptEditor() {
  const utils = api.useUtils();
  const prompts = api.ai.prompts.useQuery();
  const [flowId, setFlowId] = useState<AiPromptFlowId>("explanations");
  const [nodeId, setNodeId] = useState(AI_PROMPT_FLOWS[0]?.nodes[0]?.id ?? "");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const byKey = useMemo(() => {
    const map = new Map<string, PromptRecord>();
    for (const prompt of prompts.data ?? []) map.set(prompt.key, prompt);
    return map;
  }, [prompts.data]);

  const flow =
    AI_PROMPT_FLOWS.find((entry) => entry.id === flowId) ?? AI_PROMPT_FLOWS[0];
  const node =
    flow?.nodes.find((entry) => entry.id === nodeId) ?? flow?.nodes[0];
  const availableParts = (node?.parts ?? []).filter((part) =>
    byKey.has(part.key),
  );
  const selected =
    byKey.get(selectedKey ?? "") ??
    byKey.get(availableParts[0]?.key ?? "") ??
    null;

  useEffect(() => {
    if (!node) return;
    const keys = node.parts
      .map((part) => part.key)
      .filter((key) => byKey.has(key));
    if (keys.length === 0) return;
    if (!selectedKey || !keys.some((key) => key === selectedKey)) {
      setSelectedKey(keys[0] ?? null);
    }
  }, [byKey, node, selectedKey]);

  useEffect(() => {
    if (!selected) return;
    setDrafts((current) =>
      selected.key in current
        ? current
        : { ...current, [selected.key]: selected.body },
    );
  }, [selected]);

  const save = api.ai.savePrompt.useMutation({
    onSuccess: async (_result, input) => {
      await utils.ai.prompts.invalidate();
      setDrafts((current) => ({ ...current, [input.key]: input.body }));
      toast.success("Prompt saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const restore = api.ai.restorePrompt.useMutation({
    onSuccess: async () => {
      await utils.ai.prompts.invalidate();
      if (selected) {
        setDrafts((current) => ({
          ...current,
          [selected.key]: selected.defaultBody,
        }));
      }
      toast.success("Prompt restored to the shipped default");
    },
    onError: (error) => toast.error(error.message),
  });

  const draft = selected ? (drafts[selected.key] ?? selected.body) : "";
  const dirty = Boolean(selected && draft !== selected.body);
  const busy = save.isPending || restore.isPending;
  const selectedPart = availableParts.find(
    (part) => part.key === selected?.key,
  );

  return (
    <section
      aria-labelledby="ai-prompts-heading"
      className="bg-surface/70 mt-4 overflow-hidden rounded-2xl border border-line"
    >
      <div className="border-b border-line px-5 py-5 sm:px-6">
        <h2 id="ai-prompts-heading" className="text-base font-medium">
          Model prompts
        </h2>
        <p className="text-mist mt-1 max-w-3xl text-xs leading-5">
          Click a pipeline, then a step, to edit the instructions ReviewDuck
          sends to the model. Placeholders like {"{{pull_request}}"} are filled
          with escaped repository data. On this deployment, edits apply to every
          review.
        </p>
      </div>
      {prompts.isPending ? (
        <div className="text-mist flex min-h-48 items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading prompts…
        </div>
      ) : prompts.error ? (
        <p className="px-5 py-5 text-sm text-red-700 sm:px-6 dark:text-red-300">
          {prompts.error.message}
        </p>
      ) : flow && node ? (
        <>
          <div className="border-b border-line px-5 py-4 sm:px-6">
            <div
              role="tablist"
              aria-label="Prompt pipelines"
              className="flex flex-wrap gap-2"
            >
              {AI_PROMPT_FLOWS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={entry.id === flow.id}
                  onClick={() => {
                    setFlowId(entry.id);
                    setNodeId(entry.nodes[0]?.id ?? "");
                    setSelectedKey(entry.nodes[0]?.parts[0]?.key ?? null);
                  }}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-sm transition",
                    entry.id === flow.id
                      ? "border-violet/40 bg-violet/10 text-cloud"
                      : "border-line text-mist hover:border-line-strong hover:bg-surface-hover",
                  )}
                >
                  {entry.title}
                </button>
              ))}
            </div>
            <p className="text-mist mt-3 max-w-3xl text-xs leading-5">
              {flow.description}
            </p>
            <PromptFlowGraph
              flow={flow}
              nodeId={node.id}
              modifiedKeys={modifiedKeys(byKey, drafts)}
              onSelect={(next) => {
                setNodeId(next.id);
                setSelectedKey(next.parts[0]?.key ?? null);
              }}
            />
          </div>
          <div className="grid lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
            <nav
              aria-label={`${node.title} prompts`}
              className="border-b border-line lg:border-r lg:border-b-0"
            >
              <div className="px-5 pt-4 pb-2 sm:px-6">
                <p className="text-cloud text-sm font-medium">{node.title}</p>
                <p className="text-mist mt-1 text-xs leading-5">
                  {node.summary}
                </p>
              </div>
              <ul className="pb-3">
                {availableParts.map((part) => {
                  const record = byKey.get(part.key);
                  const partDraft = drafts[part.key] ?? record?.body;
                  const edited =
                    Boolean(record?.modified) ||
                    Boolean(record && partDraft !== record.body);
                  return (
                    <li key={part.key}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(part.key)}
                        className={cn(
                          "hover:bg-surface-hover flex w-full flex-col items-start gap-1 px-5 py-2.5 text-left sm:px-6",
                          part.key === selected?.key
                            ? "bg-surface-subtle text-cloud"
                            : "text-mist",
                        )}
                      >
                        <span className="flex w-full items-center justify-between gap-2 text-sm">
                          <span>{part.label}</span>
                          {edited && (
                            <Badge className="border-violet/25 bg-violet/10 text-violet shrink-0">
                              Edited
                            </Badge>
                          )}
                        </span>
                        <span className="text-fog text-[11px] leading-4">
                          {part.note}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
            {selected && (
              <div className="flex min-w-0 flex-col">
                <div className="border-b border-line px-5 py-5 sm:px-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-cloud text-sm font-medium">
                        {selected.title}
                      </h3>
                      <p className="text-mist mt-1 text-xs leading-5">
                        {selected.description}
                      </p>
                      {selectedPart && (
                        <p className="text-fog mt-2 text-[11px] leading-4">
                          {selectedPart.note}
                        </p>
                      )}
                    </div>
                    {selected.modified && (
                      <Badge className="border-violet/25 bg-violet/10 text-violet">
                        Different from default
                      </Badge>
                    )}
                  </div>
                  {selected.placeholders.length > 0 && (
                    <dl className="mt-4 grid gap-2 text-xs">
                      {selected.placeholders.map((placeholder) => (
                        <div key={placeholder.name} className="min-w-0">
                          <dt className="text-cloud font-mono">
                            {`{{${placeholder.name}}}`}
                          </dt>
                          <dd className="text-mist mt-0.5">
                            {placeholder.description}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
                <textarea
                  value={draft}
                  spellCheck={false}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDrafts((current) => ({
                      ...current,
                      [selected.key]: value,
                    }));
                  }}
                  aria-label={selected.title}
                  className="bg-surface text-cloud focus:border-violet/40 min-h-[22rem] w-full flex-1 resize-y border-0 border-b border-line px-5 py-4 font-mono text-xs leading-5 outline-none sm:px-6"
                />
                <div className="flex flex-wrap justify-end gap-2 px-5 py-4 sm:px-6">
                  <Button
                    variant="secondary"
                    disabled={!selected.modified || busy}
                    onClick={() => restore.mutate({ key: selected.key })}
                  >
                    {restore.isPending && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    Restore default
                  </Button>
                  <Button
                    variant={dirty ? "primary" : "secondary"}
                    disabled={!dirty || draft.trim().length === 0 || busy}
                    onClick={() =>
                      save.mutate({ key: selected.key, body: draft })
                    }
                  >
                    {save.isPending && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    Save prompt
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Renders the ordered, clickable steps of one prompt pipeline. */
function PromptFlowGraph({
  flow,
  nodeId,
  modifiedKeys,
  onSelect,
}: {
  flow: AiPromptFlow;
  nodeId: string;
  modifiedKeys: ReadonlySet<string>;
  onSelect: (node: AiPromptFlowNode) => void;
}) {
  return (
    <ol className="mt-4 flex flex-wrap items-stretch gap-2">
      {flow.nodes.map((entry, index) => {
        const selected = entry.id === nodeId;
        const edited = entry.keys.some((key) => modifiedKeys.has(key));
        return (
          <li key={entry.id} className="flex items-center gap-2">
            {index > 0 && (
              <span aria-hidden="true" className="text-fog text-sm">
                →
              </span>
            )}
            <button
              type="button"
              aria-label={
                entry.optional
                  ? `Optional: ${entry.title}`
                  : `Step ${index + 1}: ${entry.title}`
              }
              aria-current={selected ? "step" : undefined}
              onClick={() => onSelect(entry)}
              className={cn(
                "min-w-[7.5rem] rounded-xl border px-3 py-2 text-left transition",
                selected
                  ? "border-violet/40 bg-violet/10"
                  : "border-line hover:border-line-strong hover:bg-surface-hover",
              )}
            >
              <span className="text-fog flex items-center gap-2 text-[10px] font-medium tracking-wide uppercase">
                {entry.optional ? "Optional" : `Step ${index + 1}`}
                {edited && <span className="bg-violet size-1.5 rounded-full" />}
              </span>
              <span
                className={cn(
                  "mt-0.5 block text-sm",
                  selected ? "text-cloud" : "text-mist",
                )}
              >
                {entry.title}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Keys whose stored body or unsaved draft differs from the shipped default. */
function modifiedKeys(
  byKey: Map<string, PromptRecord>,
  drafts: Record<string, string>,
) {
  const keys = new Set<string>();
  for (const [key, record] of byKey) {
    const draft = drafts[key] ?? record.body;
    if (record.modified || draft !== record.defaultBody) keys.add(key);
  }
  return keys;
}
