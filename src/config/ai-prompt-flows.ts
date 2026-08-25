import { AI_PROMPT_KEYS, type AiPromptKey } from "~/config/ai-prompt-catalog";

export const AI_PROMPT_FLOW_IDS = [
  "explanations",
  "deep_review",
  "grouping",
] as const;

export type AiPromptFlowId = (typeof AI_PROMPT_FLOW_IDS)[number];

export interface AiPromptFlowPart {
  key: AiPromptKey;
  label: string;
  note: string;
}

export interface AiPromptFlowNode {
  id: string;
  title: string;
  summary: string;
  optional?: boolean;
  keys: readonly AiPromptKey[];
  parts: readonly AiPromptFlowPart[];
}

export interface AiPromptFlow {
  id: AiPromptFlowId;
  title: string;
  description: string;
  nodes: readonly AiPromptFlowNode[];
}

const explainShared: AiPromptFlowPart = {
  key: "explain.shared",
  label: "Shared rules",
  note: "Used for both explanations and questions",
};

const explainUnit: AiPromptFlowPart = {
  key: "explain.unit_task",
  label: "Explain a unit",
  note: "When there is no reviewer question",
};

const explainQuestion: AiPromptFlowPart = {
  key: "explain.question_task",
  label: "Answer a question",
  note: "When the reviewer asked about a line",
};

const explainSubmit: AiPromptFlowPart = {
  key: "explain.submit",
  label: "Submit",
  note: "Closing line on every run",
};

const changeTypeParts: readonly AiPromptFlowPart[] = [
  {
    key: "deep_review.change.pr_deleted",
    label: "PR deleted",
    note: "Pull request deleted a file",
  },
  {
    key: "deep_review.change.pr_added",
    label: "PR added",
    note: "Pull request added a file",
  },
  {
    key: "deep_review.change.pr_renamed",
    label: "PR renamed",
    note: "Pull request renamed a file",
  },
  {
    key: "deep_review.change.pr_modified",
    label: "PR modified",
    note: "Pull request edited a file",
  },
  {
    key: "deep_review.change.repo_deleted",
    label: "Repo deleted",
    note: "Snapshot no longer contains the file",
  },
  {
    key: "deep_review.change.repo_current",
    label: "Repo current",
    note: "Live snapshot file",
  },
];

/** Pipelines an administrator can inspect and edit, in run order. */
export const AI_PROMPT_FLOWS: readonly AiPromptFlow[] = [
  {
    id: "explanations",
    title: "Explanations",
    description:
      "One model call explains a review unit or answers a line question. The system prompt is sent as the system role. Shared rules, one task, and the submit line are assembled into a single user message. Pull-request XML stays in code.",
    nodes: [
      {
        id: "system",
        title: "System",
        summary: "Always sent as the model system prompt.",
        keys: ["explain.system"],
        parts: [
          {
            key: "explain.system",
            label: "System prompt",
            note: "Applies to explanations and questions",
          },
        ],
      },
      {
        id: "shared",
        title: "Shared rules",
        summary: "First section of the user message.",
        keys: ["explain.shared"],
        parts: [explainShared],
      },
      {
        id: "task",
        title: "Task",
        summary: "Exactly one of these tasks is inserted next.",
        keys: ["explain.unit_task", "explain.question_task"],
        parts: [explainUnit, explainQuestion],
      },
      {
        id: "submit",
        title: "Submit",
        summary: "Last section of the user message.",
        keys: ["explain.submit"],
        parts: [explainSubmit],
      },
    ],
  },
  {
    id: "deep_review",
    title: "Deep review",
    description:
      "The same pipeline reviews a pull request or a repository snapshot. User prompts, validation, dedupe, and the scout closer are shared. Only the plan, scout, and survey system prompts — plus change-type snippets — differ by scope.",
    nodes: [
      {
        id: "plan",
        title: "Plan",
        summary:
          "Optional pre-scan for a large file. Ranks where the scout should look first.",
        optional: true,
        keys: [
          "deep_review.plan.system",
          "deep_review.plan.system_repository",
          "deep_review.plan.user",
        ],
        parts: [
          {
            key: "deep_review.plan.system",
            label: "System · pull request",
            note: "Large pull-request files only",
          },
          {
            key: "deep_review.plan.system_repository",
            label: "System · repository",
            note: "Large snapshot files only",
          },
          {
            key: "deep_review.plan.user",
            label: "Request",
            note: "Shared by pull requests and snapshots",
          },
        ],
      },
      {
        id: "scout",
        title: "Scout",
        summary:
          "Per-file reviewer. Reads the file, reports findings, then finishes.",
        keys: [
          "deep_review.scout.system",
          "deep_review.scout.system_repository",
          "deep_review.scout.user",
          "deep_review.final_turn",
        ],
        parts: [
          {
            key: "deep_review.scout.system",
            label: "System · pull request",
            note: "One changed file on a pull request",
          },
          {
            key: "deep_review.scout.system_repository",
            label: "System · repository",
            note: "One file from a snapshot",
          },
          {
            key: "deep_review.scout.user",
            label: "Request",
            note: "Shared by pull requests and snapshots",
          },
          {
            key: "deep_review.final_turn",
            label: "Final turn",
            note: "Appended when no further scout turns remain",
          },
        ],
      },
      {
        id: "change",
        title: "Change type",
        summary:
          "Short guidance injected into plan and scout requests as {{change_type_guidance}}.",
        keys: [
          "deep_review.change.pr_deleted",
          "deep_review.change.pr_added",
          "deep_review.change.pr_renamed",
          "deep_review.change.pr_modified",
          "deep_review.change.repo_deleted",
          "deep_review.change.repo_current",
        ],
        parts: changeTypeParts,
      },
      {
        id: "validate",
        title: "Validate",
        summary:
          "After the scout, snippets that missed the file are relocated, then findings are fact-checked.",
        keys: [
          "deep_review.relocate.system",
          "deep_review.relocate.user",
          "deep_review.refute.system",
          "deep_review.refute.user",
        ],
        parts: [
          {
            key: "deep_review.relocate.system",
            label: "Locator system",
            note: "Shared by every review",
          },
          {
            key: "deep_review.relocate.user",
            label: "Locator request",
            note: "Shared by every review",
          },
          {
            key: "deep_review.refute.system",
            label: "Fact-check system",
            note: "Shared by every review",
          },
          {
            key: "deep_review.refute.user",
            label: "Fact-check request",
            note: "Shared by every review",
          },
        ],
      },
      {
        id: "survey",
        title: "Survey",
        summary:
          "One cross-file pass after every file scout. Looks at seams, not file bodies.",
        keys: [
          "deep_review.survey.system",
          "deep_review.survey.system_repository",
          "deep_review.survey.user",
        ],
        parts: [
          {
            key: "deep_review.survey.system",
            label: "System · pull request",
            note: "Seams between changed files",
          },
          {
            key: "deep_review.survey.system_repository",
            label: "System · repository",
            note: "Repository-wide contracts",
          },
          {
            key: "deep_review.survey.user",
            label: "Request",
            note: "Shared by pull requests and snapshots",
          },
        ],
      },
      {
        id: "dedupe",
        title: "Dedupe",
        summary:
          "Groups findings that describe the same defect in the same place.",
        keys: ["deep_review.dedupe.system", "deep_review.dedupe.user"],
        parts: [
          {
            key: "deep_review.dedupe.system",
            label: "System",
            note: "Shared by every review",
          },
          {
            key: "deep_review.dedupe.user",
            label: "Request",
            note: "Shared by every review",
          },
        ],
      },
    ],
  },
  {
    id: "grouping",
    title: "Grouping",
    description:
      "A structured call partitions review units into concepts. A repair prompt is sent only when the first answer is incomplete.",
    nodes: [
      {
        id: "system",
        title: "System",
        summary: "Always sent as the model system prompt.",
        keys: ["semantic.cluster.system"],
        parts: [
          {
            key: "semantic.cluster.system",
            label: "System prompt",
            note: "Untrusted-manifest and partition rules",
          },
        ],
      },
      {
        id: "request",
        title: "Request",
        summary: "Asks for a complete partition of the unit manifest.",
        keys: ["semantic.cluster.user"],
        parts: [
          {
            key: "semantic.cluster.user",
            label: "Grouping request",
            note: "First call",
          },
        ],
      },
      {
        id: "repair",
        title: "Repair",
        summary:
          "Sent only when the first partition is missing, duplicated, or unknown IDs.",
        optional: true,
        keys: ["semantic.cluster.repair"],
        parts: [
          {
            key: "semantic.cluster.repair",
            label: "Repair request",
            note: "Only after a rejected partition",
          },
        ],
      },
    ],
  },
];

/** Returns the flow that owns a prompt key. */
export function aiPromptFlowForKey(key: AiPromptKey) {
  for (const flow of AI_PROMPT_FLOWS) {
    const node = flow.nodes.find((entry) => entry.keys.includes(key));
    if (node) return { flow, node };
  }
  return undefined;
}

/** Returns whether every catalog key appears in exactly one flow node. */
export function aiPromptFlowCoverage() {
  const seen = new Map<AiPromptKey, string>();
  const duplicate: AiPromptKey[] = [];
  for (const flow of AI_PROMPT_FLOWS) {
    for (const node of flow.nodes) {
      for (const key of node.keys) {
        const prior = seen.get(key);
        if (prior) duplicate.push(key);
        else seen.set(key, `${flow.id}.${node.id}`);
      }
    }
  }
  const missing = AI_PROMPT_KEYS.filter((key) => !seen.has(key));
  return { missing, duplicate };
}
