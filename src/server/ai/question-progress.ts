type QuestionJobStatus =
  | "queued"
  | "running"
  | "waiting_for_provider"
  | "streaming";

interface QuestionToolActivity {
  status: string;
  toolName: string;
}

interface QuestionProgressInput {
  createdAt: Date;
  model: string | null;
  now?: Date;
  progress: number;
  status: QuestionJobStatus;
  tool?: QuestionToolActivity;
}

const toolActivity: Record<string, { active: string; complete: string }> = {
  list_files: {
    active: "Mapping repository files",
    complete: "repository files mapped",
  },
  search_code: {
    active: "Searching changed code",
    complete: "changed code searched",
  },
  semantic_search: {
    active: "Searching indexed symbols",
    complete: "indexed symbols searched",
  },
  read_file: {
    active: "Reading source code",
    complete: "source code read",
  },
  submit_answer: {
    active: "Finalizing the answer",
    complete: "answer finalized",
  },
};

/** Formats a compact duration that remains readable inside an answer card. */
export function formatAiElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Turns durable job state into truthful, useful focused-answer progress. */
export function aiQuestionProgress({
  createdAt,
  model,
  now = new Date(),
  progress,
  status,
  tool,
}: QuestionProgressInput) {
  const elapsed = formatAiElapsed(now.getTime() - createdAt.getTime());
  const activity = tool ? toolActivity[tool.toolName] : undefined;
  let detail: string;
  if (tool?.status === "running") {
    detail = activity?.active ?? "Using a review tool";
  } else if (status === "queued") {
    detail = "Queued for the local AI worker";
  } else if (status === "running") {
    detail = "Preparing review context";
  } else if (status === "streaming") {
    detail = "Writing the answer";
  } else {
    detail = `Waiting for ${model || "the model provider"}`;
    if (progress > 0) detail += ` · investigation pass ${progress}`;
    if (activity?.complete) detail += ` · ${activity.complete}`;
  }
  return `${detail} · ${elapsed}`;
}
