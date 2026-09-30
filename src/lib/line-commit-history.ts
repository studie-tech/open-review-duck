import {
  type LineDiffOperation,
  lineDiffOperations,
} from "~/lib/side-by-side-diff";

/** Highest number of file commits whose hunks are mapped onto lines. */
export const FILE_COMMIT_MAP_LIMIT = 40;

/**
 * Orders commits from parent links so a replay follows history, not response order.
 *
 * A commit whose parent is outside the set is a root. Children follow that parent.
 * Commits the links cannot place keep their original relative order.
 */
export function oldestFirstByParent<
  T extends { sha: string; parents: readonly string[] },
>(commits: readonly T[]) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const commit of commits) {
    const parent = commit.parents.find((sha) => bySha.has(sha));
    if (!parent) {
      roots.push(commit);
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(commit);
    children.set(parent, list);
  }
  const ordered: T[] = [];
  const pending = [...roots];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const commit = pending.shift();
    if (!commit || seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    ordered.push(commit);
    for (const child of children.get(commit.sha) ?? []) pending.push(child);
  }
  for (const commit of commits) {
    if (!seen.has(commit.sha)) ordered.push(commit);
  }
  return ordered;
}

/**
 * Keeps pull-request commits that touched a file, in pull-request order.
 *
 * Callers fetch patches only for the returned shas. A longer history is
 * truncated so a later replay cannot pretend a partial walk is exact.
 */
export function pullRequestFileCommitShas(
  pullShasOldestFirst: readonly string[],
  touchingShas: ReadonlySet<string>,
) {
  const shas = pullShasOldestFirst.filter((sha) => touchingShas.has(sha));
  return {
    shas: shas.slice(0, FILE_COMMIT_MAP_LIMIT),
    truncated: shas.length > FILE_COMMIT_MAP_LIMIT,
  };
}

export interface CommitHunk {
  oldStart: number;
  oldCount: number;
  lines: Array<" " | "+" | "-">;
}

/** One pull-request commit and the unified diff it made to a single file. */
export interface FileCommitPatch {
  sha: string;
  author: string;
  authoredAt: string;
  message: string;
  url?: string;
  patch: string | null;
  merge: boolean;
}

/** A commit annotated with the base and head lines it still explains. */
export interface LineHistoryCommit {
  sha: string;
  shortSha: string;
  author: string;
  authoredAt: string;
  subject: string;
  body: string;
  url?: string;
  baseLines: number[];
  headLines: number[];
  mapped: boolean;
}

/** Result of mapping a file's pull-request commits onto the reviewed diff. */
export interface LineHistory {
  commits: LineHistoryCommit[];
  truncated: boolean;
  unmapped: boolean;
}

interface TrackedLine {
  baseLine?: number;
  touches: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/** Splits a source file into lines without a phantom trailing blank line. */
function sourceLines(source: string) {
  if (source.length === 0) return [];
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Parses unified-diff hunks, ignoring git headers and newline markers. */
export function parseUnifiedHunks(patch: string): CommitHunk[] {
  const hunks: CommitHunk[] = [];
  let current: CommitHunk | undefined;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    if (line.startsWith("+")) current.lines.push("+");
    else if (line.startsWith("-")) current.lines.push("-");
    else if (line.startsWith(" ")) current.lines.push(" ");
  }
  return hunks;
}

/** Groups a line diff into hunks the commit walker can apply. */
export function hunksFromOperations(
  operations: readonly LineDiffOperation[],
): CommitHunk[] {
  const hunks: CommitHunk[] = [];
  let oldLine = 1;
  let index = 0;
  while (index < operations.length) {
    if (operations[index]?.side === "both") {
      oldLine += 1;
      index += 1;
      continue;
    }
    const oldStart = oldLine;
    const lines: Array<" " | "+" | "-"> = [];
    let oldCount = 0;
    while (index < operations.length && operations[index]?.side !== "both") {
      if (operations[index]?.side === "previous") {
        lines.push("-");
        oldCount += 1;
        oldLine += 1;
      } else {
        lines.push("+");
      }
      index += 1;
    }
    hunks.push({ oldStart, oldCount, lines });
  }
  return hunks;
}

/** Builds a unified diff whose hunks survive a parse round trip. */
export function unifiedPatch(previous: string, current: string) {
  const hunks = hunksFromOperations(
    lineDiffOperations(sourceLines(previous), sourceLines(current)),
  );
  return hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldCount} +1,1 @@\n${hunk.lines.join("\n")}`,
    )
    .join("\n");
}

/** Returns the first subject line and the remaining commit message body. */
function splitCommitMessage(message: string) {
  const normalized = message.replaceAll("\r\n", "\n").trim();
  const breakAt = normalized.indexOf("\n");
  if (breakAt < 0) return { subject: normalized, body: "" };
  return {
    subject: normalized.slice(0, breakAt).trim(),
    body: normalized.slice(breakAt + 1).trim(),
  };
}

/** Appends a sha once, keeping the order commits were applied. */
function remember(touches: readonly string[], sha: string) {
  return touches.includes(sha) ? [...touches] : [...touches, sha];
}

/** Records that a commit removed a line which still traces to the base file. */
function recordRemoval(
  line: TrackedLine,
  sha: string,
  baseTouches: Map<number, string[]>,
) {
  if (line.baseLine === undefined) return;
  const touches = remember(line.touches, sha);
  const existing = baseTouches.get(line.baseLine) ?? [];
  baseTouches.set(line.baseLine, [...new Set([...existing, ...touches])]);
}

/**
 * Replays one hunk onto the file, carrying base-line identity through edits.
 *
 * A delete paired with an add keeps the base line number, so a later commit
 * that removes the replacement still explains the original base line.
 */
function applyHunk(
  lines: TrackedLine[],
  hunk: CommitHunk,
  sha: string,
  nextBaseLine: { value: number },
  baseTouches: Map<number, string[]>,
) {
  const start = hunk.oldStart <= 0 ? 0 : hunk.oldStart - 1;
  while (lines.length < start + hunk.oldCount) {
    lines.push({ baseLine: nextBaseLine.value, touches: [] });
    nextBaseLine.value += 1;
  }
  const removed = lines.slice(start, start + hunk.oldCount);
  const next: TrackedLine[] = [];
  let removedIndex = 0;
  let index = 0;
  while (index < hunk.lines.length) {
    if (hunk.lines[index] === " ") {
      const line = removed[removedIndex];
      if (line) next.push(line);
      removedIndex += 1;
      index += 1;
      continue;
    }
    const deleted: TrackedLine[] = [];
    while (index < hunk.lines.length && hunk.lines[index] === "-") {
      const line = removed[removedIndex];
      if (line) deleted.push(line);
      removedIndex += 1;
      index += 1;
    }
    let added = 0;
    while (index < hunk.lines.length && hunk.lines[index] === "+") {
      added += 1;
      index += 1;
    }
    const pairs = Math.min(deleted.length, added);
    for (let pair = 0; pair < pairs; pair += 1) {
      const prior = deleted[pair];
      if (!prior) continue;
      next.push({
        baseLine: prior.baseLine,
        touches: remember(prior.touches, sha),
      });
    }
    for (let pair = pairs; pair < deleted.length; pair += 1) {
      const prior = deleted[pair];
      if (prior) recordRemoval(prior, sha, baseTouches);
    }
    for (let pair = pairs; pair < added; pair += 1) {
      next.push({ touches: [sha] });
    }
  }
  while (removedIndex < removed.length) {
    const line = removed[removedIndex];
    if (line) next.push(line);
    removedIndex += 1;
  }
  lines.splice(start, hunk.oldCount, ...next);
}

/**
 * Maps pull-request commits onto the base and head lines of the reviewed file.
 *
 * Commits are applied in the order given, which callers make oldest first.
 * The returned list is newest first.
 * Merge commits are omitted. A missing patch, or a file with more commits
 * than can be replayed, is reported as unmapped and matches every selection.
 */
export function attributeFileCommits(input: {
  commits: readonly FileCommitPatch[];
  truncated: boolean;
}): LineHistory {
  const ordered = input.commits.filter((commit) => !commit.merge);
  const unmapped =
    input.truncated || ordered.some((commit) => commit.patch === null);
  const lines: TrackedLine[] = [];
  const nextBaseLine = { value: 1 };
  const baseTouches = new Map<number, string[]>();
  if (!unmapped) {
    for (const commit of ordered) {
      let offset = 0;
      for (const hunk of parseUnifiedHunks(commit.patch ?? "")) {
        const oldStart =
          hunk.oldStart <= 0 ? hunk.oldStart : hunk.oldStart + offset;
        applyHunk(
          lines,
          { ...hunk, oldStart },
          commit.sha,
          nextBaseLine,
          baseTouches,
        );
        const newCount = hunk.lines.filter((line) => line !== "-").length;
        offset += newCount - hunk.oldCount;
      }
    }
    for (const line of lines) {
      if (line.touches.length === 0 || line.baseLine === undefined) continue;
      const existing = baseTouches.get(line.baseLine) ?? [];
      baseTouches.set(line.baseLine, [
        ...new Set([...existing, ...line.touches]),
      ]);
    }
  }
  const headTouches = new Map<number, string[]>();
  if (!unmapped) {
    lines.forEach((line, index) => {
      if (line.touches.length === 0) return;
      headTouches.set(index + 1, line.touches);
    });
  }
  const commits = ordered.flatMap((commit) => {
    const { subject, body } = splitCommitMessage(commit.message);
    const mapped = !unmapped && commit.patch !== null;
    const baseLines = mapped
      ? [...baseTouches.entries()]
          .filter(([, touches]) => touches.includes(commit.sha))
          .map(([line]) => line)
          .sort((left, right) => left - right)
      : [];
    const headLines = mapped
      ? [...headTouches.entries()]
          .filter(([, touches]) => touches.includes(commit.sha))
          .map(([line]) => line)
          .sort((left, right) => left - right)
      : [];
    if (mapped && baseLines.length === 0 && headLines.length === 0) return [];
    return [
      {
        sha: commit.sha,
        shortSha: commit.sha.slice(0, 7),
        author: commit.author,
        authoredAt: commit.authoredAt,
        subject,
        body,
        url: commit.url,
        baseLines,
        headLines,
        mapped,
      },
    ];
  });
  return {
    commits: commits.reverse(),
    truncated: input.truncated,
    unmapped,
  };
}

/** Lines of a diff selection, split by how they show up in the review. */
export interface LineHistorySelection {
  baseLines: number[];
  headLines: number[];
  removedBaseLines: number[];
  addedHeadLines: number[];
  changedBaseLines: number[];
  changedHeadLines: number[];
}

/** Keeps commits that touched the selection, plus any that could not be mapped. */
export function commitsForSelection(
  commits: readonly LineHistoryCommit[],
  selection: LineHistorySelection,
) {
  const base = new Set(selection.baseLines);
  const head = new Set(selection.headLines);
  return commits.filter(
    (commit) =>
      !commit.mapped ||
      commit.baseLines.some((line) => base.has(line)) ||
      commit.headLines.some((line) => head.has(line)),
  );
}

/** Renders sorted line numbers as compact inclusive ranges. */
export function formatLineList(lines: readonly number[]) {
  const sorted = [...new Set(lines)].sort((left, right) => left - right);
  const first = sorted[0];
  if (first === undefined) return "";
  const ranges: string[] = [];
  let start = first;
  let end = first;
  for (const line of sorted.slice(1)) {
    if (line === end + 1) {
      end = line;
      continue;
    }
    ranges.push(start === end ? `${start}` : `${start}–${end}`);
    start = line;
    end = line;
  }
  ranges.push(start === end ? `${start}` : `${start}–${end}`);
  return ranges.join(", ");
}

/** Describes how one commit meets the reviewer's current selection. */
export function commitEffectLabels(
  commit: LineHistoryCommit,
  selection: LineHistorySelection,
) {
  if (!commit.mapped) return ["Touched this file"];
  const removed = commit.baseLines.filter((line) =>
    selection.removedBaseLines.includes(line),
  );
  const added = commit.headLines.filter((line) =>
    selection.addedHeadLines.includes(line),
  );
  const changed = [
    ...commit.baseLines.filter((line) =>
      selection.changedBaseLines.includes(line),
    ),
    ...commit.headLines.filter((line) =>
      selection.changedHeadLines.includes(line),
    ),
  ];
  const labels: string[] = [];
  if (removed.length > 0) {
    labels.push(`Removed lines ${formatLineList(removed)}`);
  }
  if (added.length > 0) labels.push(`Added lines ${formatLineList(added)}`);
  if (changed.length > 0) {
    labels.push(`Changed lines ${formatLineList(changed)}`);
  }
  return labels;
}
