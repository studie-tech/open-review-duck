import { sanitizeReason } from "./redaction";

export type RefuteVerdict = "unverified" | "not_refuted" | "refuted";

export interface RefuteVote {
  id: string;
  verdict: "refuted" | "not_refuted";
  refutation?: string;
  evidencePath?: string;
  evidenceLine?: number;
}

export interface RefuteResolution {
  verdict: RefuteVerdict;
  reason: string | null;
}

interface RefuteBatch {
  votes: readonly RefuteVote[];
  findingIds: readonly string[];
  snapshotPaths: readonly string[];
}

/** Returns whether a model-supplied field carries usable text. */
function isFilledText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Builds the resolution that keeps a finding alive. */
function unverified(): RefuteResolution {
  return { verdict: "unverified", reason: null };
}

/** Reports the assertions that make a whole refutation batch unusable. */
export function refuteVoteErrors(input: RefuteBatch): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const vote of input.votes) {
    // A repeated id means the batch no longer maps one judgement to one
    // finding, so nothing in it can be trusted — including the votes that
    // look well formed.
    if (seen.has(vote.id)) {
      const id = sanitizeReason(vote.id, { maxLength: 80 });
      const message = `duplicate refutation vote for finding ${id}`;
      if (!errors.includes(message)) errors.push(message);
      continue;
    }
    seen.add(vote.id);
  }
  return errors;
}

/** Resolves one vote, discarding a refutation that misses the evidence bar. */
function resolveVote(
  vote: RefuteVote,
  snapshotPaths: ReadonlySet<string>,
): RefuteResolution {
  if (vote.verdict === "refuted") {
    if (!isFilledText(vote.refutation)) return unverified();
    if (!isFilledText(vote.evidencePath)) return unverified();
    if (!snapshotPaths.has(vote.evidencePath)) return unverified();
    const reason = sanitizeReason(vote.refutation);
    // A discard with no surviving text is not auditable, whatever redaction
    // does to the wording later.
    if (reason.length === 0) return unverified();
    return { verdict: "refuted", reason };
  }
  if (vote.verdict === "not_refuted") {
    return { verdict: "not_refuted", reason: null };
  }
  // An unrecognized verdict is a malformed response, not a licence to drop.
  return unverified();
}

/** Settles every finding's verdict, failing open on any batch anomaly. */
export function applyRefuteVerdicts(
  input: RefuteBatch,
): Map<string, RefuteResolution> {
  const resolutions = new Map<string, RefuteResolution>();
  for (const id of input.findingIds) resolutions.set(id, unverified());
  if (refuteVoteErrors(input).length > 0) return resolutions;

  const snapshotPaths = new Set(input.snapshotPaths);
  for (const vote of input.votes) {
    // Votes for ids we never asked about are ignored rather than fatal.
    if (!resolutions.has(vote.id)) continue;
    resolutions.set(vote.id, resolveVote(vote, snapshotPaths));
  }
  return resolutions;
}
