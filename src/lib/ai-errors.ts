const AI_SERVICE_UNAVAILABLE = "AI service unavailable";
const AI_REQUEST_TIMED_OUT = "AI request timed out";

/** Builds the title and remediation copy for an AI failure. */
export function aiErrorPresentation(error?: string | null) {
  const normalized = error?.toLowerCase() ?? "";

  if (
    normalized === AI_SERVICE_UNAVAILABLE.toLowerCase() ||
    normalized.includes("fetch failed") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("runtime_unavailable") ||
    normalized.includes("local runtime is temporarily unavailable")
  ) {
    return {
      title: AI_SERVICE_UNAVAILABLE,
      detail:
        "The configured model could not be reached. Check its URL and credentials, then try again.",
    };
  }

  if (
    normalized === AI_REQUEST_TIMED_OUT.toLowerCase() ||
    normalized.includes("timed out") ||
    normalized.includes("timeout")
  ) {
    return {
      title: AI_REQUEST_TIMED_OUT,
      detail:
        "The model did not finish in time. Retry, or choose a faster model with a smaller output limit.",
    };
  }

  return {
    title: "Explanation failed",
    detail: error || "The explanation could not complete.",
  };
}
