import { basename, dirname, extname } from "node:path";
import { sha256 } from "./hash";
import type { AnalyzedUnit } from "./types";

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

/** Derives a lexical owner from normalized qualified declaration names. */
function lexicalContainer(unit: AnalyzedUnit) {
  const separators = ["::", "#", ".", "/"];
  let cut = -1;
  for (const separator of separators) {
    cut = Math.max(cut, unit.name.lastIndexOf(separator));
  }
  return cut > 0 ? `${unit.path}:${unit.name.slice(0, cut)}` : undefined;
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
    if (container) {
      containers.set(container, [
        ...(containers.get(container) ?? []),
        unit.stableKey,
      ]);
    }
    for (const token of identifierTokens(unit)) {
      symbols.set(token, [...(symbols.get(token) ?? []), unit.stableKey]);
    }
    const stem = productionTestStem(unit.path);
    if (stem) stems.set(stem, [...(stems.get(stem) ?? []), unit.stableKey]);
    const parent = dirname(unit.path).split("/").slice(0, 3).join("/");
    pathParents.set(parent, [
      ...(pathParents.get(parent) ?? []),
      unit.stableKey,
    ]);
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
    const production = related.filter((unit) => !tests.includes(unit));
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
  for (const unit of reviewable) {
    byPath.set(unit.path, [...(byPath.get(unit.path) ?? []), unit]);
  }
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
    const left = byKey.get(edge.left);
    const right = byKey.get(edge.right);
    if (!left || !right) continue;
    const leftTokens = identifierTokens(left);
    const rightTokens = identifierTokens(right);
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
    incident.set(edge.left, [...(incident.get(edge.left) ?? []), edge]);
    incident.set(edge.right, [...(incident.get(edge.right) ?? []), edge]);
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

/** Chooses the most central member with stable tie-breaking. */
function conceptAnchor(
  members: string[],
  edges: AffinityEdge[],
  byKey: Map<string, AnalyzedUnit>,
) {
  const memberSet = new Set(members);
  const weights = new Map(members.map((key) => [key, 0]));
  for (const edge of edges) {
    if (memberSet.has(edge.left) && memberSet.has(edge.right)) {
      weights.set(edge.left, (weights.get(edge.left) ?? 0) + edge.score);
      weights.set(edge.right, (weights.get(edge.right) ?? 0) + edge.score);
    }
  }
  return [...members].sort(
    (left, right) =>
      (weights.get(right) ?? 0) - (weights.get(left) ?? 0) ||
      (byKey.get(left)?.reviewOrder ?? 0) -
        (byKey.get(right)?.reviewOrder ?? 0) ||
      left.localeCompare(right),
  )[0] as string;
}

/** Ensures a proposed group is compact around its deterministic anchor. */
function withinTwoStrongHops(
  members: string[],
  edges: AffinityEdge[],
  byKey: Map<string, AnalyzedUnit>,
) {
  if (members.length <= 1) return true;
  const memberSet = new Set(members);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (
      edge.score < MERGE_THRESHOLD ||
      !memberSet.has(edge.left) ||
      !memberSet.has(edge.right)
    ) {
      continue;
    }
    adjacency.set(
      edge.left,
      (adjacency.get(edge.left) ?? new Set()).add(edge.right),
    );
    adjacency.set(
      edge.right,
      (adjacency.get(edge.right) ?? new Set()).add(edge.left),
    );
  }
  const anchor = conceptAnchor(members, edges, byKey);
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
      !withinTwoStrongHops(proposed, edges, byKey)
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
    const anchorKey = conceptAnchor(stableMembers, edges, byKey);
    const anchor = byKey.get(anchorKey) ?? orderedMembers[0];
    if (!anchor) throw new Error("A review concept cannot be empty");
    const paths = new Set(orderedMembers.map(({ path }) => path));
    const changedLineCount = orderedMembers.reduce(
      (total, unit) => total + unit.changedLineCount,
      0,
    );
    const internalEdges = edges.filter(
      (edge) =>
        stableMembers.includes(edge.left) && stableMembers.includes(edge.right),
    );
    const reasons = [
      ...new Set(internalEdges.flatMap(({ reasons }) => reasons)),
    ];
    const hasTest = orderedMembers.some(
      ({ kind }) =>
        kind === "test" || kind === "test_suite" || kind === "test_hook",
    );
    const hasProduction = orderedMembers.some(
      ({ kind }) => !["test", "test_suite", "test_hook"].includes(kind),
    );
    const title =
      hasTest && hasProduction
        ? `${anchor.name} and tests`
        : paths.size > 1
          ? `${anchor.name} across ${paths.size} files`
          : stableMembers.length > 1
            ? `${anchor.name} and related changes`
            : anchor.name;
    return {
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
  return ordered.map((concept, reviewOrder) => ({ ...concept, reviewOrder }));
}

/** Fails closed when a layout can hide, duplicate, or overgrow review work. */
export function validateConceptPartition(
  units: Array<Pick<AnalyzedUnit, "stableKey" | "path" | "changedLineCount">>,
  concepts: Array<Pick<ReviewConceptDefinition, "memberStableKeys">>,
) {
  const expected = new Set(units.map(({ stableKey }) => stableKey));
  const seen = new Set<string>();
  for (const concept of concepts) {
    if (concept.memberStableKeys.length === 0) {
      throw new Error("A review concept cannot be empty");
    }
    const members = concept.memberStableKeys.map((key) => {
      if (!expected.has(key)) throw new Error(`Unknown review unit ${key}`);
      if (seen.has(key)) throw new Error(`Duplicate review unit ${key}`);
      seen.add(key);
      return units.find(
        (unit) => unit.stableKey === key,
      ) as (typeof units)[number];
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
}
