import { basename, dirname, extname } from "node:path";
import { appendToIndex } from "~/lib/keyed-index";
import {
  changedLineMasks,
  type UnitRangeSource,
  unitOwnershipRanges,
} from "./engine";
import { sha256 } from "./hash";
import type { AnalyzedUnit, SourceFile } from "./types";

export const MAX_CONCEPT_FILES = 10;
export const MAX_CONCEPT_CHANGED_LINES = 500;
const MERGE_THRESHOLD = 60;
const MAX_LOW_CONFIDENCE_NEIGHBORS = 32;

export interface ReviewConceptDefinition {
  stableKey: string;
  title: string;
  rationale: string;
  reviewOrder: number;
  changedLineCount: number;
  fileCount: number;
  oversized: boolean;
  dependencies: string[];
  memberStableKeys: string[];
}

interface AffinityEdge {
  left: string;
  right: string;
  score: number;
  explicit: boolean;
  reasons: string[];
}

const tokenStopWords = new Set([
  "class",
  "const",
  "data",
  "default",
  "function",
  "index",
  "method",
  "module",
  "object",
  "result",
  "string",
  "test",
  "tests",
  "type",
  "value",
]);

/** Returns stable language-neutral identifier tokens for one unit. */
function identifierTokens(unit: AnalyzedUnit) {
  return new Set(
    `${unit.name} ${unit.signature ?? ""}`
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 3 && !tokenStopWords.has(token)),
  );
}

const qualifiedNameSeparators = ["::", "#", ".", "/"];

/** Splits a qualified declaration name into its owner and its final segment. */
function splitQualifiedName(name: string) {
  let cut = -1;
  let separator = "";
  for (const candidate of qualifiedNameSeparators) {
    const index = name.lastIndexOf(candidate);
    if (index > cut) {
      cut = index;
      separator = candidate;
    }
  }
  // A leading separator marks a sigil rather than an owner — Ruby's "#run" is
  // an unqualified method — so it yields a bare segment and no container.
  return {
    owner: cut > 0 ? name.slice(0, cut) : undefined,
    segment: cut < 0 ? name : name.slice(cut + separator.length),
  };
}

/** Derives a lexical owner from normalized qualified declaration names. */
function lexicalContainer(unit: AnalyzedUnit) {
  const { owner } = splitQualifiedName(unit.name);
  return owner === undefined ? undefined : `${unit.path}:${owner}`;
}

/** Returns whether a unit reviews test code rather than the behaviour under test. */
function isTestUnit({ kind }: AnalyzedUnit) {
  return kind === "test" || kind === "test_suite" || kind === "test_hook";
}

/**
 * Detects a title a reviewer can locate in the code the concept shows.
 *
 * A parser titles a declaration with an identifier it read out of that
 * declaration, so the identifier is present in the source the card renders.
 * Ranges the analyzer has to invent instead — module sweeps, changed-line
 * fragments, whole-file context — are titled with generated prose such as
 * "Module statements" or "Changed line 723" that appears nowhere in the code
 * and so names nothing a reviewer can act on. Testing a name against its own
 * source separates the two without a per-language list of generated labels.
 */
function namesOwnSource(unit: AnalyzedUnit) {
  const source = `${unit.source}\n${unit.previousSource ?? ""}`;
  if (source.includes(unit.name)) return true;
  const { segment } = splitQualifiedName(unit.name);
  return segment.length >= 3 && source.includes(segment);
}

/** Normalizes production and test paths to a shared relationship key. */
function productionTestStem(path: string) {
  const extension = extname(path);
  const file = basename(path, extension)
    .replace(/(?:[._-](?:test|tests|spec|specs))$/i, "")
    .replace(/^(?:test|spec)[._-]/i, "");
  return file.length >= 3 ? file.toLowerCase() : undefined;
}

/** Adds capped evidence to one undirected pair. */
function addEvidence(
  edges: Map<string, AffinityEdge>,
  left: string,
  right: string,
  score: number,
  reason: string,
  explicit = false,
) {
  if (left === right) return;
  const [first, second] =
    left.localeCompare(right) < 0 ? [left, right] : [right, left];
  const key = `${first}\0${second}`;
  const edge = edges.get(key) ?? {
    left: first,
    right: second,
    score: 0,
    explicit: false,
    reasons: [],
  };
  edge.score = Math.min(160, edge.score + score);
  edge.explicit ||= explicit;
  if (!edge.reasons.includes(reason)) edge.reasons.push(reason);
  edges.set(key, edge);
}

/** Connects each indexed group without constructing an unbounded clique. */
function addIndexedEvidence(
  index: Map<string, string[]>,
  edges: Map<string, AffinityEdge>,
  score: number,
  reason: string,
) {
  for (const keys of index.values()) {
    const members = [...new Set(keys)].sort();
    if (members.length < 2 || members.length > 48) continue;
    for (let index = 1; index < members.length; index += 1) {
      const current = members[index];
      const prior = members[index - 1];
      const anchor = members[0];
      if (current && prior) addEvidence(edges, prior, current, score, reason);
      if (current && anchor && prior !== anchor) {
        addEvidence(edges, anchor, current, score, reason);
      }
    }
  }
}

/** Builds a bounded provider-independent affinity graph. */
export function buildConceptAffinityGraph(units: AnalyzedUnit[]) {
  const reviewable = units.filter(({ kind }) => kind !== "file");
  const byKey = new Map(reviewable.map((unit) => [unit.stableKey, unit]));
  const edges = new Map<string, AffinityEdge>();
  const containers = new Map<string, string[]>();
  const symbols = new Map<string, string[]>();
  const stems = new Map<string, string[]>();
  const pathParents = new Map<string, string[]>();
  const tokensByKey = new Map<string, Set<string>>();

  for (const unit of reviewable) {
    for (const dependency of unit.dependencies) {
      if (byKey.has(dependency)) {
        addEvidence(
          edges,
          unit.stableKey,
          dependency,
          100,
          "direct code dependency",
          true,
        );
      }
    }
    const container = lexicalContainer(unit);
    if (container) appendToIndex(containers, container, unit.stableKey);
    const tokens = identifierTokens(unit);
    tokensByKey.set(unit.stableKey, tokens);
    for (const token of tokens) appendToIndex(symbols, token, unit.stableKey);
    const stem = productionTestStem(unit.path);
    if (stem) appendToIndex(stems, stem, unit.stableKey);
    const parent = dirname(unit.path).split("/").slice(0, 3).join("/");
    appendToIndex(pathParents, parent, unit.stableKey);
  }

  addIndexedEvidence(containers, edges, 80, "same lexical container");
  // Identifier indexes only make candidate lookup sparse. Similarity is scored
  // below and cannot merge units without stronger structural evidence.
  addIndexedEvidence(symbols, edges, 0, "shared identifier candidate");

  for (const keys of stems.values()) {
    const related = [...new Set(keys)]
      .map((key) => byKey.get(key))
      .filter((unit): unit is AnalyzedUnit => Boolean(unit));
    const tests = related.filter(
      (unit) =>
        unit.kind === "test" ||
        unit.kind === "test_suite" ||
        /(?:^|[/_.-])tests?(?:[/_.-]|$)|(?:^|[/_.-])specs?(?:[/_.-]|$)/i.test(
          unit.path,
        ),
    );
    const testSet = new Set(tests);
    const production = related.filter((unit) => !testSet.has(unit));
    for (const test of tests.slice(0, 16)) {
      for (const source of production.slice(0, 16)) {
        addEvidence(
          edges,
          test.stableKey,
          source.stableKey,
          90,
          "production and test pair",
        );
      }
    }
  }

  const byPath = new Map<string, AnalyzedUnit[]>();
  for (const unit of reviewable) appendToIndex(byPath, unit.path, unit);
  for (const pathUnits of byPath.values()) {
    const ordered = pathUnits.sort(
      (left, right) =>
        left.startLine - right.startLine ||
        left.stableKey.localeCompare(right.stableKey),
    );
    for (let index = 0; index < ordered.length; index += 1) {
      const left = ordered[index];
      if (!left) continue;
      for (let offset = 1; offset <= 4; offset += 1) {
        const right = ordered[index + offset];
        if (!right) break;
        const gap = Math.max(0, right.startLine - left.endLine);
        if (gap > 120) break;
        addEvidence(
          edges,
          left.stableKey,
          right.stableKey,
          Math.max(10, 35 - Math.floor(gap / 5)),
          "nearby change in the same file",
        );
      }
    }
  }
  addIndexedEvidence(pathParents, edges, 20, "shared module path");

  for (const edge of edges.values()) {
    const leftTokens = tokensByKey.get(edge.left);
    const rightTokens = tokensByKey.get(edge.right);
    if (!leftTokens || !rightTokens) continue;
    const shared = [...leftTokens].filter((token) => rightTokens.has(token));
    const union = new Set([...leftTokens, ...rightTokens]);
    if (shared.length > 0 && union.size > 0) {
      const score = Math.min(25, Math.round((shared.length / union.size) * 25));
      edge.score = Math.min(160, edge.score + score);
      edge.reasons.push("similar identifiers");
    }
  }

  const incident = new Map<string, AffinityEdge[]>();
  for (const edge of edges.values()) {
    appendToIndex(incident, edge.left, edge);
    appendToIndex(incident, edge.right, edge);
  }
  const retained = new Set<AffinityEdge>();
  for (const nodeEdges of incident.values()) {
    const explicit = nodeEdges.filter(({ explicit }) => explicit);
    const other = nodeEdges
      .filter(({ explicit }) => !explicit)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.left.localeCompare(right.left) ||
          left.right.localeCompare(right.right),
      )
      .slice(0, MAX_LOW_CONFIDENCE_NEIGHBORS);
    for (const edge of [...explicit, ...other]) retained.add(edge);
  }
  return [...retained].sort(
    (left, right) =>
      right.score - left.score ||
      left.left.localeCompare(right.left) ||
      left.right.localeCompare(right.right),
  );
}

/** Indexes each affinity edge under both of its endpoints by graph position. */
function incidentEdgeIndex(edges: AffinityEdge[]) {
  const incident = new Map<string, number[]>();
  edges.forEach((edge, position) => {
    appendToIndex(incident, edge.left, position);
    appendToIndex(incident, edge.right, position);
  });
  return incident;
}

/**
 * Lists the edges joining two members of one group, in affinity-graph order.
 *
 * Scanning the whole graph for every group costs the product of the two, which
 * a pull request pays twice over because a group is examined once when it is
 * proposed and again when it is described. An endpoint index reaches only the
 * edges that could possibly qualify, and restoring graph position keeps the
 * rationale wording identical to a scan of the graph itself.
 */
function internalEdges(
  members: readonly string[],
  edges: AffinityEdge[],
  incident: Map<string, number[]>,
) {
  const memberSet = new Set(members);
  const positions = new Set<number>();
  for (const member of members) {
    for (const position of incident.get(member) ?? []) {
      const edge = edges[position];
      if (edge && memberSet.has(edge.left) && memberSet.has(edge.right)) {
        positions.add(position);
      }
    }
  }
  return [...positions]
    .sort((left, right) => left - right)
    .flatMap((position) => edges[position] ?? []);
}

/** Sums how much affinity evidence holds each member inside one group. */
function internalAffinityWeights(members: string[], edges: AffinityEdge[]) {
  const weights = new Map(members.map((key) => [key, 0]));
  for (const edge of edges) {
    weights.set(edge.left, (weights.get(edge.left) ?? 0) + edge.score);
    weights.set(edge.right, (weights.get(edge.right) ?? 0) + edge.score);
  }
  return weights;
}

/** Chooses the most central member with stable tie-breaking. */
function conceptAnchor(
  members: string[],
  internal: AffinityEdge[],
  byKey: Map<string, AnalyzedUnit>,
) {
  const weights = internalAffinityWeights(members, internal);
  return [...members].sort(
    (left, right) =>
      (weights.get(right) ?? 0) - (weights.get(left) ?? 0) ||
      (byKey.get(left)?.reviewOrder ?? 0) -
        (byKey.get(right)?.reviewOrder ?? 0) ||
      left.localeCompare(right),
  )[0] as string;
}

/**
 * Chooses the member whose name states what a concept exists to justify.
 *
 * Graph centrality answers a different question — which member holds the group
 * together — and a shared type or constant is the most central member of almost
 * every group it appears in, which is how a five-line interface ends up naming a
 * refresh-policy change. Titles therefore rank by review signal instead:
 *
 * 1. a name a reviewer can find in the code beats generated prose, because a
 *    line number or "Module statements" names nothing anyone can act on;
 * 2. production code beats a test, because a test is named after the behaviour
 *    it asserts while the production edit is the behaviour under review;
 * 3. the member carrying more of the group's changed lines beats a bystander the
 *    change merely brushed;
 * 4. affinity weight breaks the remaining ties, so among members carrying equal
 *    change the most depended-upon one names the group.
 *
 * Review order and stable key keep the choice deterministic.
 */
function conceptTitleAnchor(
  members: string[],
  internal: AffinityEdge[],
  byKey: Map<string, AnalyzedUnit>,
) {
  const weights = internalAffinityWeights(members, internal);
  return members
    .flatMap((key) => {
      const unit = byKey.get(key);
      return unit
        ? [
            {
              unit,
              nameable: namesOwnSource(unit) ? 1 : 0,
              production: isTestUnit(unit) ? 0 : 1,
              weight: weights.get(key) ?? 0,
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        right.nameable - left.nameable ||
        right.production - left.production ||
        right.unit.changedLineCount - left.unit.changedLineCount ||
        right.weight - left.weight ||
        left.unit.reviewOrder - right.unit.reviewOrder ||
        left.unit.stableKey.localeCompare(right.unit.stableKey),
    )[0]?.unit;
}

/** Ensures a proposed group is compact around its deterministic anchor. */
function withinTwoStrongHops(
  members: string[],
  internal: AffinityEdge[],
  byKey: Map<string, AnalyzedUnit>,
) {
  if (members.length <= 1) return true;
  const adjacency = new Map<string, Set<string>>();
  for (const edge of internal) {
    if (edge.score < MERGE_THRESHOLD) continue;
    adjacency.set(
      edge.left,
      (adjacency.get(edge.left) ?? new Set()).add(edge.right),
    );
    adjacency.set(
      edge.right,
      (adjacency.get(edge.right) ?? new Set()).add(edge.left),
    );
  }
  const anchor = conceptAnchor(members, internal, byKey);
  const reached = new Set([anchor]);
  let frontier = [anchor];
  for (let depth = 0; depth < 2; depth += 1) {
    frontier = frontier.flatMap((key) => [...(adjacency.get(key) ?? [])]);
    frontier.forEach((key) => {
      reached.add(key);
    });
  }
  return members.every((key) => reached.has(key));
}

/** Creates deterministic, constrained concepts from atomic review units. */
export function clusterReviewConcepts(
  allUnits: AnalyzedUnit[],
): ReviewConceptDefinition[] {
  const units = allUnits.filter(({ kind }) => kind !== "file");
  const byKey = new Map(units.map((unit) => [unit.stableKey, unit]));
  const edges = buildConceptAffinityGraph(units);
  const incident = incidentEdgeIndex(edges);
  const parent = new Map(units.map((unit) => [unit.stableKey, unit.stableKey]));
  const members = new Map(
    units.map((unit) => [unit.stableKey, [unit.stableKey]]),
  );
  /** Finds one path-compressed group root. */
  const find = (key: string): string => {
    const next = parent.get(key) ?? key;
    if (next === key) return key;
    const root = find(next);
    parent.set(key, root);
    return root;
  };

  for (const edge of edges) {
    if (edge.score < MERGE_THRESHOLD) break;
    const leftRoot = find(edge.left);
    const rightRoot = find(edge.right);
    if (leftRoot === rightRoot) continue;
    const proposed = [
      ...(members.get(leftRoot) ?? []),
      ...(members.get(rightRoot) ?? []),
    ];
    const files = new Set(proposed.map((key) => byKey.get(key)?.path));
    const lines = proposed.reduce(
      (total, key) => total + (byKey.get(key)?.changedLineCount ?? 0),
      0,
    );
    if (
      files.size > MAX_CONCEPT_FILES ||
      lines > MAX_CONCEPT_CHANGED_LINES ||
      !withinTwoStrongHops(
        proposed,
        internalEdges(proposed, edges, incident),
        byKey,
      )
    ) {
      continue;
    }
    const root = leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
    const child = root === leftRoot ? rightRoot : leftRoot;
    parent.set(child, root);
    members.set(root, proposed.sort());
    members.delete(child);
  }

  const groups = [...new Set(units.map((unit) => find(unit.stableKey)))].map(
    (root) => members.get(root) ?? [root],
  );
  const drafts = groups.map((memberKeys) => {
    const orderedMembers = memberKeys
      .map((key) => byKey.get(key))
      .filter((unit): unit is AnalyzedUnit => Boolean(unit))
      .sort(
        (left, right) =>
          left.reviewOrder - right.reviewOrder ||
          left.stableKey.localeCompare(right.stableKey),
      );
    const stableMembers = orderedMembers.map(({ stableKey }) => stableKey);
    const internal = internalEdges(stableMembers, edges, incident);
    const anchor = conceptTitleAnchor(stableMembers, internal, byKey);
    if (!anchor) throw new Error("A review concept cannot be empty");
    const paths = new Set(orderedMembers.map(({ path }) => path));
    const changedLineCount = orderedMembers.reduce(
      (total, unit) => total + unit.changedLineCount,
      0,
    );
    const reasons = [...new Set(internal.flatMap(({ reasons }) => reasons))];
    const hasTest = orderedMembers.some(isTestUnit);
    const hasProduction = orderedMembers.some((unit) => !isTestUnit(unit));
    // A group whose best anchor is still generated prose has no name to offer,
    // so the title falls back to the one thing such a range does carry: where a
    // reviewer opens it.
    const subject = namesOwnSource(anchor)
      ? anchor.name
      : `${anchor.name} in ${basename(anchor.path)}`;
    const title =
      hasTest && hasProduction
        ? `${subject} and tests`
        : paths.size > 1
          ? `${subject} across ${paths.size} files`
          : stableMembers.length > 1
            ? `${subject} and related changes`
            : subject;
    return {
      anchorLocation: `${anchor.path}:${anchor.startLine}`,
      stableKey: `concept:${sha256(stableMembers.slice().sort().join("\0"))}`,
      title,
      rationale:
        reasons.length > 0
          ? `Grouped by ${reasons.slice(0, 3).join(", ")}.`
          : "This change remains a standalone review concept.",
      reviewOrder: Math.min(
        ...orderedMembers.map(({ reviewOrder }) => reviewOrder),
      ),
      changedLineCount,
      fileCount: paths.size,
      oversized:
        stableMembers.length === 1 &&
        (paths.size > MAX_CONCEPT_FILES ||
          changedLineCount > MAX_CONCEPT_CHANGED_LINES),
      dependencies: [] as string[],
      memberStableKeys: stableMembers,
    };
  });
  const conceptByUnit = new Map(
    drafts.flatMap((concept) =>
      concept.memberStableKeys.map((key) => [key, concept.stableKey] as const),
    ),
  );
  for (const concept of drafts) {
    concept.dependencies = [
      ...new Set(
        concept.memberStableKeys.flatMap((key) =>
          (byKey.get(key)?.dependencies ?? []).flatMap((dependency) => {
            const target = conceptByUnit.get(dependency);
            return target && target !== concept.stableKey ? [target] : [];
          }),
        ),
      ),
    ].sort();
  }

  const byConcept = new Map(
    drafts.map((concept) => [concept.stableKey, concept]),
  );
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const ordered: typeof drafts = [];
  /** Emits dependencies before the dependent concept, condensing cycles safely. */
  const visit = (concept: (typeof drafts)[number]) => {
    if (emitted.has(concept.stableKey) || visiting.has(concept.stableKey))
      return;
    visiting.add(concept.stableKey);
    concept.dependencies
      .map((key) => byConcept.get(key))
      .filter((value): value is (typeof drafts)[number] => Boolean(value))
      .sort(
        (left, right) =>
          left.reviewOrder - right.reviewOrder ||
          left.stableKey.localeCompare(right.stableKey),
      )
      .forEach(visit);
    visiting.delete(concept.stableKey);
    emitted.add(concept.stableKey);
    ordered.push(concept);
  };
  drafts
    .sort(
      (left, right) =>
        left.reviewOrder - right.reviewOrder ||
        left.stableKey.localeCompare(right.stableKey),
    )
    .forEach(visit);
  // Two cards sharing a title are indistinguishable to whoever signs them off,
  // so a repeated title is qualified by where its anchor opens.
  const titleCounts = new Map<string, number>();
  for (const { title } of ordered) {
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return ordered.map(({ anchorLocation, ...concept }, reviewOrder) => ({
    ...concept,
    reviewOrder,
    title:
      (titleCounts.get(concept.title) ?? 0) > 1
        ? `${concept.title} (${anchorLocation})`
        : concept.title,
  }));
}

type PartitionUnit = Pick<
  AnalyzedUnit,
  "changedLineCount" | "path" | "stableKey"
> &
  UnitRangeSource;

/**
 * Reports changed lines of one modified file that no concept member renders.
 *
 * Membership alone proves every unit is reachable, not every changed line: the
 * analyzer may credit a line to the nearest unit while showing a range that
 * excludes it, which is how an added import used to disappear from the review.
 * Blank lines are exempt because there is nothing on them to judge, and only
 * modified files are checked — an added or deleted file is reviewed whole, so
 * its preamble is context for the declarations shipping with it.
 */
function unrenderedChangedLines(file: SourceFile, units: PartitionUnit[]) {
  if (file.changeType !== "modified" || file.previousContent === undefined) {
    return [];
  }
  const masks = changedLineMasks(file.previousContent, file.content);
  const sources = {
    previous: file.previousContent.split("\n"),
    current: file.content.split("\n"),
  };
  return (["previous", "current"] as const).flatMap((side) => {
    // Every unit's rendered span is derived once and merged, so a changed line
    // is answered by a single interval lookup instead of a rescan of the file's
    // units — the difference between a per-line and a per-file cost.
    const rendered = units
      .flatMap((unit) => unitOwnershipRanges(unit, side))
      .sort((left, right) => left.startLine - right.startLine);
    let cursor = 0;
    let coveredThrough = 0;
    return masks[side].flatMap((isChanged, index) => {
      const line = index + 1;
      while (
        cursor < rendered.length &&
        (rendered[cursor]?.startLine ?? 0) <= line
      ) {
        coveredThrough = Math.max(
          coveredThrough,
          rendered[cursor]?.endLine ?? 0,
        );
        cursor += 1;
      }
      if (!isChanged || !sources[side][index]?.trim()) return [];
      return line <= coveredThrough
        ? []
        : [
            `${file.path} ${side === "previous" ? "base" : "head"} line ${line}`,
          ];
    });
  });
}

/** Fails closed when a layout can hide, duplicate, or overgrow review work. */
export function validateConceptPartition(
  units: PartitionUnit[],
  concepts: Array<Pick<ReviewConceptDefinition, "memberStableKeys">>,
  files: SourceFile[],
) {
  const byKey = new Map<string, PartitionUnit>();
  const byPath = new Map<string, PartitionUnit[]>();
  for (const unit of units) {
    if (!byKey.has(unit.stableKey)) byKey.set(unit.stableKey, unit);
    appendToIndex(byPath, unit.path, unit);
  }
  const expected = new Set(byKey.keys());
  const seen = new Set<string>();
  for (const concept of concepts) {
    if (concept.memberStableKeys.length === 0) {
      throw new Error("A review concept cannot be empty");
    }
    const members = concept.memberStableKeys.map((key) => {
      if (!expected.has(key)) throw new Error(`Unknown review unit ${key}`);
      if (seen.has(key)) throw new Error(`Duplicate review unit ${key}`);
      seen.add(key);
      return byKey.get(key) as (typeof units)[number];
    });
    const files = new Set(members.map(({ path }) => path)).size;
    const lines = members.reduce((sum, unit) => sum + unit.changedLineCount, 0);
    if (
      members.length > 1 &&
      (files > MAX_CONCEPT_FILES || lines > MAX_CONCEPT_CHANGED_LINES)
    ) {
      throw new Error(
        "A review concept exceeds its file or changed-line limit",
      );
    }
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter((key) => !seen.has(key));
    throw new Error(`Review concept layout is missing ${missing.join(", ")}`);
  }
  const unrendered = files.flatMap((file) =>
    unrenderedChangedLines(file, byPath.get(file.path) ?? []),
  );
  // A line no unit renders is review work a reviewer cannot reach, but it
  // degrades one pull request rather than invalidating it. Refusing the whole
  // revision would leave nothing reviewable at all, so report and continue.
  if (unrendered.length > 0) {
    console.warn(`Review concepts never show changed ${unrendered.join(", ")}`);
  }
}
