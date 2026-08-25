export const AI_PROMPT_GROUPS = [
  "Explanations",
  "Deep review",
  "Grouping",
] as const;

export type AiPromptGroup = (typeof AI_PROMPT_GROUPS)[number];

export const AI_PROMPT_KEYS = [
  "explain.system",
  "explain.shared",
  "explain.question_task",
  "explain.unit_task",
  "explain.submit",
  "semantic.cluster.system",
  "semantic.cluster.user",
  "semantic.cluster.repair",
  "deep_review.final_turn",
  "deep_review.scout.system",
  "deep_review.scout.system_repository",
  "deep_review.scout.user",
  "deep_review.plan.system",
  "deep_review.plan.system_repository",
  "deep_review.plan.user",
  "deep_review.relocate.system",
  "deep_review.relocate.user",
  "deep_review.refute.system",
  "deep_review.refute.user",
  "deep_review.survey.system",
  "deep_review.survey.system_repository",
  "deep_review.survey.user",
  "deep_review.dedupe.system",
  "deep_review.dedupe.user",
  "deep_review.change.pr_deleted",
  "deep_review.change.pr_added",
  "deep_review.change.pr_renamed",
  "deep_review.change.pr_modified",
  "deep_review.change.repo_deleted",
  "deep_review.change.repo_current",
] as const;

export type AiPromptKey = (typeof AI_PROMPT_KEYS)[number];

export interface AiPromptPlaceholder {
  name: string;
  description: string;
}

export interface AiPromptDefinition {
  key: AiPromptKey;
  title: string;
  description: string;
  group: AiPromptGroup;
  placeholders: readonly AiPromptPlaceholder[];
}

const contextSlots: readonly AiPromptPlaceholder[] = [
  {
    name: "pull_request",
    description: "Escaped pull-request title, description, and branches",
  },
];

const fileSlots: readonly AiPromptPlaceholder[] = [
  ...contextSlots,
  {
    name: "file_under_review",
    description: "Path and change type for the file being reviewed",
  },
  {
    name: "change_type_guidance",
    description: "How to treat added, deleted, renamed, or snapshot files",
  },
  { name: "changed_ranges", description: "Changed line ranges in this file" },
  { name: "unit_manifest", description: "Indexed symbols in this file" },
  { name: "review_checklist", description: "Rulebook or compliance checklist" },
  { name: "current_revision", description: "Current file revision" },
  { name: "previous_revision", description: "Previous file revision" },
];

/** Describes every model-facing prompt an administrator may edit. */
export const AI_PROMPT_CATALOG: Record<AiPromptKey, AiPromptDefinition> = {
  "explain.system": {
    key: "explain.system",
    title: "Explanation system",
    description:
      "System prompt for every unit explanation and line question. Sent as the model system role.",
    group: "Explanations",
    placeholders: [],
  },
  "explain.shared": {
    key: "explain.shared",
    title: "Shared rules",
    description:
      "Read-only and untrusted-data rules. Assembled into the user message for both explanations and questions.",
    group: "Explanations",
    placeholders: [],
  },
  "explain.question_task": {
    key: "explain.question_task",
    title: "Answer a question",
    description:
      "Task text used when the reviewer asked about a focused line. Replaces the unit-explanation task in the same user message.",
    group: "Explanations",
    placeholders: [],
  },
  "explain.unit_task": {
    key: "explain.unit_task",
    title: "Explain a unit",
    description:
      "Task text used for an automatic or on-demand unit explanation. Replaces the question task in the same user message.",
    group: "Explanations",
    placeholders: [],
  },
  "explain.submit": {
    key: "explain.submit",
    title: "Submit result",
    description:
      "Closing instruction appended to every explanation and question user message.",
    group: "Explanations",
    placeholders: [],
  },
  "semantic.cluster.system": {
    key: "semantic.cluster.system",
    title: "Grouping system",
    description:
      "System prompt for grouping review units by implementation intent.",
    group: "Grouping",
    placeholders: [],
  },
  "semantic.cluster.user": {
    key: "semantic.cluster.user",
    title: "Grouping request",
    description:
      "First user prompt. Asks for a complete partition of the unit manifest.",
    group: "Grouping",
    placeholders: [
      { name: "manifest", description: "JSON manifest of units and concepts" },
    ],
  },
  "semantic.cluster.repair": {
    key: "semantic.cluster.repair",
    title: "Grouping repair",
    description:
      "Follow-up user prompt sent only when the first partition is incomplete or invalid.",
    group: "Grouping",
    placeholders: [
      { name: "missing", description: "Missing unit IDs" },
      { name: "duplicate", description: "Duplicated unit IDs" },
      { name: "unknown", description: "Unknown unit IDs" },
      { name: "manifest", description: "JSON manifest" },
      { name: "proposal", description: "JSON of the rejected partition" },
    ],
  },
  "deep_review.final_turn": {
    key: "deep_review.final_turn",
    title: "Scout final turn",
    description:
      "User message appended on the last scout turn. Shared by pull-request and repository reviews.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.scout.system": {
    key: "deep_review.scout.system",
    title: "Scout system · pull request",
    description: "System prompt for one-file pull-request review.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.scout.system_repository": {
    key: "deep_review.scout.system_repository",
    title: "Scout system · repository",
    description:
      "System prompt for one-file repository snapshot review. Same scout user prompt as pull requests.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.scout.user": {
    key: "deep_review.scout.user",
    title: "Scout request",
    description:
      "User prompt that frames one file. Shared by pull-request and repository reviews.",
    group: "Deep review",
    placeholders: [
      ...fileSlots,
      { name: "review_plan", description: "Optional pre-scan checkpoints" },
    ],
  },
  "deep_review.plan.system": {
    key: "deep_review.plan.system",
    title: "Plan system · pull request",
    description:
      "System prompt for ranking risk in a large changed pull-request file. Skipped for small files.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.plan.system_repository": {
    key: "deep_review.plan.system_repository",
    title: "Plan system · repository",
    description:
      "System prompt for ranking risk in a large snapshot file. Same plan user prompt as pull requests.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.plan.user": {
    key: "deep_review.plan.user",
    title: "Plan request",
    description:
      "User prompt that asks for a JSON review plan. Shared by pull-request and repository reviews.",
    group: "Deep review",
    placeholders: fileSlots,
  },
  "deep_review.relocate.system": {
    key: "deep_review.relocate.system",
    title: "Locator system",
    description:
      "System prompt for re-extracting a snippet that did not match the file. Shared by every review.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.relocate.user": {
    key: "deep_review.relocate.user",
    title: "Locator request",
    description:
      "User prompt that asks for a verbatim snippet. Shared by every review.",
    group: "Deep review",
    placeholders: [
      { name: "changed_source", description: "File contents" },
      { name: "failed_snippet", description: "Snippet that did not match" },
      { name: "finding", description: "Finding body" },
    ],
  },
  "deep_review.refute.system": {
    key: "deep_review.refute.system",
    title: "Fact-check system",
    description:
      "System prompt for dropping findings the source disproves. Shared by every review.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.refute.user": {
    key: "deep_review.refute.user",
    title: "Fact-check request",
    description:
      "User prompt that lists findings for one file. Shared by every review.",
    group: "Deep review",
    placeholders: [
      { name: "file_under_review", description: "File path" },
      { name: "current_revision", description: "Current file revision" },
      { name: "previous_revision", description: "Previous file revision" },
      { name: "findings", description: "Untrusted finding payload" },
    ],
  },
  "deep_review.survey.system": {
    key: "deep_review.survey.system",
    title: "Survey system · pull request",
    description: "System prompt for cross-file pull-request seam review.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.survey.system_repository": {
    key: "deep_review.survey.system_repository",
    title: "Survey system · repository",
    description:
      "System prompt for whole-repository survey. Same survey user prompt as pull requests.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.survey.user": {
    key: "deep_review.survey.user",
    title: "Survey request",
    description:
      "User prompt that frames the changed-file manifest. Shared by pull-request and repository reviews.",
    group: "Deep review",
    placeholders: [
      ...contextSlots,
      { name: "review_checklist", description: "Optional checklist" },
      { name: "changed_files", description: "File manifest" },
      { name: "units", description: "Indexed units" },
      { name: "dependencies", description: "Dependency edges" },
      {
        name: "file_findings",
        description: "Per-file findings already reported",
      },
      {
        name: "closing_instruction",
        description: "Pull-request or repository closing instruction",
      },
    ],
  },
  "deep_review.dedupe.system": {
    key: "deep_review.dedupe.system",
    title: "Dedupe system",
    description:
      "System prompt for grouping duplicate findings. Shared by every review.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.dedupe.user": {
    key: "deep_review.dedupe.user",
    title: "Dedupe request",
    description:
      "User prompt that lists surviving findings. Shared by every review.",
    group: "Deep review",
    placeholders: [{ name: "findings", description: "Untrusted finding list" }],
  },
  "deep_review.change.pr_deleted": {
    key: "deep_review.change.pr_deleted",
    title: "Deleted pull-request file",
    description:
      "Injected into plan and scout user prompts when a pull request deletes a file.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.change.pr_added": {
    key: "deep_review.change.pr_added",
    title: "Added pull-request file",
    description:
      "Injected into plan and scout user prompts when a pull request adds a file.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.change.pr_renamed": {
    key: "deep_review.change.pr_renamed",
    title: "Renamed pull-request file",
    description:
      "Injected into plan and scout user prompts when a pull request renames a file.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.change.pr_modified": {
    key: "deep_review.change.pr_modified",
    title: "Modified pull-request file",
    description:
      "Injected into plan and scout user prompts when a pull request edits a file.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.change.repo_deleted": {
    key: "deep_review.change.repo_deleted",
    title: "Deleted repository file",
    description:
      "Injected into plan and scout user prompts when a snapshot no longer contains a file.",
    group: "Deep review",
    placeholders: [],
  },
  "deep_review.change.repo_current": {
    key: "deep_review.change.repo_current",
    title: "Current repository file",
    description:
      "Injected into plan and scout user prompts when reviewing a live snapshot file.",
    group: "Deep review",
    placeholders: [],
  },
};

/** Returns catalog metadata for a known prompt key. */
export function aiPromptDefinition(
  key: string,
): AiPromptDefinition | undefined {
  return key in AI_PROMPT_CATALOG
    ? AI_PROMPT_CATALOG[key as AiPromptKey]
    : undefined;
}

/** Returns whether a string is a known prompt key. */
export function isAiPromptKey(key: string): key is AiPromptKey {
  return key in AI_PROMPT_CATALOG;
}
