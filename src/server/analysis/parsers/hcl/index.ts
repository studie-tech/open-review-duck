import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

type ReviewUnit = Omit<AnalyzedUnit, "depth" | "reviewOrder">;

interface HclBlock extends SourceRange {
  declarationFrom: number;
  opening: number;
  type: string;
  labels: string[];
  parent?: HclBlock;
}

interface HclAttribute extends SourceRange {
  declarationFrom: number;
  name: string;
}

interface PendingUnit {
  unit: ReviewUnit;
  aliases: string[];
  references: string[];
}

const independentlyMeaningfulNestedBlocks = new Set([
  "assert",
  "connection",
  "dynamic",
  "lifecycle",
  "postcondition",
  "precondition",
  "provisioner",
  "required_providers",
  "validation",
]);

/** Blanks a source range without changing offsets or line breaks. */
function blank(masked: string[], from: number, to: number) {
  for (let index = from; index < to; index += 1) {
    if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  }
}

/** Locates an HCL heredoc, including indented and quoted delimiters. */
function heredocRange(source: string, from: number) {
  const marker =
    /^<<(-)?\s*(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|([A-Za-z_][\w-]*))/.exec(
      source.slice(from),
    );
  const delimiter = marker?.[2] ?? marker?.[3] ?? marker?.[4];
  if (!marker || !delimiter) return undefined;
  const openingEnd = source.indexOf("\n", from + marker[0].length);
  if (openingEnd < 0) return { from, to: source.length };
  let lineFrom = openingEnd + 1;
  while (lineFrom <= source.length) {
    const newline = source.indexOf("\n", lineFrom);
    const lineTo = newline < 0 ? source.length : newline;
    const line = source.slice(lineFrom, lineTo).replace(/\r$/, "");
    const candidate = marker[1] ? line.trimStart() : line;
    if (candidate.trimEnd() === delimiter) {
      return { from, to: newline < 0 ? source.length : newline + 1 };
    }
    if (newline < 0) break;
    lineFrom = newline + 1;
  }
  return { from, to: source.length };
}

/** Masks HCL comments and literals while preserving structural offsets. */
function maskHclSource(source: string) {
  const masked = [...source];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index) || source[index] === "#") {
      const newline = source.indexOf("\n", index + 1);
      const to = newline < 0 ? source.length : newline;
      blank(masked, index, to);
      index = to;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const to = close < 0 ? source.length : close + 2;
      blank(masked, index, to);
      index = to;
      continue;
    }
    if (source.startsWith("<<", index)) {
      const heredoc = heredocRange(source, index);
      if (heredoc) {
        blank(masked, heredoc.from, heredoc.to);
        index = heredoc.to;
        continue;
      }
    }
    if (source[index] === '"') {
      const from = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (source[index - 1] === '"') break;
      }
      blank(masked, from, index);
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

/** Masks comments but retains literals, for comments-only detection. */
function maskHclComments(source: string) {
  const masked = [...source];
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"') {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index++] === '"') break;
      }
      continue;
    }
    if (source.startsWith("<<", index)) {
      const heredoc = heredocRange(source, index);
      if (heredoc) {
        index = heredoc.to;
        continue;
      }
    }
    if (source.startsWith("//", index) || source[index] === "#") {
      const newline = source.indexOf("\n", index + 1);
      const to = newline < 0 ? source.length : newline;
      blank(masked, index, to);
      index = to;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const to = close < 0 ? source.length : close + 2;
      blank(masked, index, to);
      index = to;
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

/** Recognizes an empty HCL file or a file containing only comments. */
export function isContextOnly(source: string) {
  return maskHclComments(source).trim().length === 0;
}

/** Pairs structural HCL braces after literals and comments have been masked. */
function matchingBraces(structural: string) {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < structural.length; index += 1) {
    if (structural[index] === "{") stack.push(index);
    if (structural[index] === "}") {
      const opening = stack.pop();
      if (opening !== undefined) pairs.set(opening, index + 1);
    }
  }
  return pairs;
}

/** Decodes the escapes permitted in quoted HCL block labels. */
function decodeLabel(value: string) {
  return value.replace(/\\(["\\])/g, "$1");
}

/** Extracts ordered labels from an HCL block header. */
function blockLabels(header: string, type: string) {
  const remainder = header.slice(header.indexOf(type) + type.length);
  return [...remainder.matchAll(/"((?:\\.|[^"\\])*)"|([A-Za-z0-9_.-]+)/g)].map(
    (match) => decodeLabel(match[1] ?? match[2] ?? ""),
  );
}

/** Discovers HCL blocks and assigns their nearest containing block. */
function hclBlocks(source: string, structural: string) {
  const pairs = matchingBraces(structural);
  const blocks: HclBlock[] = [];
  const expression = /^[\t ]*([A-Za-z_][\w-]*)[^\n={]*\{/gm;
  for (const match of structural.matchAll(expression)) {
    if (match.index === undefined) continue;
    const opening = match.index + match[0].lastIndexOf("{");
    const to = pairs.get(opening);
    if (to === undefined) continue;
    const type = match[1];
    if (!type) continue;
    const declarationFrom =
      match.index + (match[0].match(/^[\t ]*/)?.[0].length ?? 0);
    const header = source.slice(declarationFrom, opening);
    blocks.push({
      from: declarationFrom,
      to,
      declarationFrom,
      opening,
      type,
      labels: blockLabels(header, type),
    });
  }
  blocks.sort((left, right) => left.from - right.from || right.to - left.to);
  for (const block of blocks) {
    block.parent = blocks
      .filter(
        (candidate) =>
          candidate !== block &&
          candidate.opening < block.from &&
          candidate.to >= block.to,
      )
      .sort((left, right) => left.to - left.from - (right.to - right.from))[0];
  }
  return blocks;
}

/** Returns the source offset at which the containing line begins. */
function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Includes a directly adjacent HCL documentation comment with a unit. */
function documentedStart(source: string, declarationFrom: number) {
  let start = lineStart(source, declarationFrom);
  let cursor = start;
  while (cursor > 0) {
    const previousEnd = cursor - 1;
    const previousStart = lineStart(source, previousEnd);
    const line = source.slice(previousStart, previousEnd).replace(/\r$/, "");
    if (/^\s*(?:#|\/\/)/.test(line)) {
      start = previousStart;
      cursor = previousStart;
      continue;
    }
    if (/\*\/\s*$/.test(line)) {
      const commentStart = source.lastIndexOf("/*", previousEnd);
      if (
        commentStart >= 0 &&
        !/\n\s*\n/.test(source.slice(commentStart, cursor))
      ) {
        start = lineStart(source, commentStart);
      }
    }
    break;
  }
  return start;
}

/** Trims trailing whitespace from a prospective source range. */
function trimEnd(source: string, offset: number) {
  let end = offset;
  while (end > 0 && /\s/.test(source[end - 1] ?? "")) end -= 1;
  return end;
}

/** Records the HCL brace depth at every source offset. */
function depthTable(structural: string) {
  const depths = new Uint32Array(structural.length + 1);
  let depth = 0;
  for (let index = 0; index < structural.length; index += 1) {
    depths[index] = depth;
    if (structural[index] === "{") depth += 1;
    else if (structural[index] === "}") depth = Math.max(0, depth - 1);
  }
  depths[structural.length] = depth;
  return depths;
}

/** Finds direct attributes in one HCL scope without entering child blocks. */
function attributesInScope(
  source: string,
  structural: string,
  depths: Uint32Array,
  from: number,
  to: number,
  depth: number,
  childBlocks: readonly HclBlock[],
) {
  const starts: Array<{ from: number; name: string }> = [];
  let offset = lineStart(source, from);
  while (offset < to) {
    const newline = source.indexOf("\n", offset);
    const lineTo = newline < 0 ? source.length : newline + 1;
    const structuralLine = structural.slice(offset, Math.min(lineTo, to));
    const match = /^\s*([A-Za-z_][\w-]*)\s*=/.exec(structuralLine);
    const declarationFrom = match
      ? offset + (structuralLine.match(/^\s*/)?.[0].length ?? 0)
      : undefined;
    if (
      match?.[1] &&
      declarationFrom !== undefined &&
      depths[declarationFrom] === depth &&
      !childBlocks.some(
        (block) => declarationFrom >= block.from && declarationFrom < block.to,
      )
    ) {
      starts.push({ from: declarationFrom, name: match[1] });
    }
    if (newline < 0) break;
    offset = newline + 1;
  }

  const boundaries = [
    ...starts.map(({ from: start }) => start),
    ...childBlocks.map(({ declarationFrom }) => declarationFrom),
  ].sort((left, right) => left - right);
  return starts.map(({ from: declarationFrom, name }) => {
    const next =
      boundaries.find((boundary) => boundary > declarationFrom) ?? to;
    return {
      from: documentedStart(source, declarationFrom),
      to: trimEnd(source, next),
      declarationFrom,
      name,
    } satisfies HclAttribute;
  });
}

/** Restores executable interpolation expressions into a masked template. */
function copyTemplateExpressions(
  source: string,
  masked: string[],
  from: number,
  to: number,
) {
  let index = from;
  while (index < to) {
    if (source.startsWith("${", index) || source.startsWith("%{", index)) {
      let depth = 1;
      let cursor = index + 2;
      let quote = false;
      while (cursor < to && depth > 0) {
        if (quote && source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === '"') quote = !quote;
        else if (!quote && source[cursor] === "{") depth += 1;
        else if (!quote && source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      for (let copied = index + 2; copied < cursor - 1; copied += 1) {
        masked[copied] = source[copied] ?? " ";
      }
      index = cursor;
      continue;
    }
    index += 1;
  }
}

/** Retains executable HCL expressions and only interpolations inside templates. */
function referenceSource(source: string) {
  const masked = [...source];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index) || source[index] === "#") {
      const newline = source.indexOf("\n", index + 1);
      const to = newline < 0 ? source.length : newline;
      blank(masked, index, to);
      index = to;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const to = close < 0 ? source.length : close + 2;
      blank(masked, index, to);
      index = to;
      continue;
    }
    if (source.startsWith("<<", index)) {
      const heredoc = heredocRange(source, index);
      if (heredoc) {
        blank(masked, heredoc.from, heredoc.to);
        copyTemplateExpressions(source, masked, heredoc.from, heredoc.to);
        index = heredoc.to;
        continue;
      }
    }
    if (source[index] === '"') {
      const from = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (source[index - 1] === '"') break;
      }
      blank(masked, from, index);
      copyTemplateExpressions(source, masked, from, index);
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

/** Extracts Terraform traversal references relevant to dependency ordering. */
function hclReferences(source: string, resourceAliases: ReadonlySet<string>) {
  const executable = referenceSource(source);
  const found = new Set<string>();
  for (const match of executable.matchAll(
    /\b(?:var|local|module)\.[A-Za-z_][\w-]*|\bdata\.[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*/g,
  )) {
    found.add(match[0]);
  }
  for (const alias of resourceAliases) {
    const expression = new RegExp(
      `\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\.|\\b)`,
      "g",
    );
    if (expression.test(executable)) found.add(alias);
  }
  return [...found];
}

/** Estimates review complexity from HCL control and validation constructs. */
function complexityOf(source: string) {
  const structural = maskHclSource(source);
  return Math.max(
    1,
    1 +
      (structural.match(
        /\b(?:for|if|dynamic|lifecycle|precondition|postcondition|validation|assert)\b|\?|&&|\|\|/g,
      )?.length ?? 0),
  );
}

/** Builds a concise signature from an HCL block or attribute header. */
function unitSignature(source: string, declarationFrom: number, to: number) {
  const header = source.slice(declarationFrom, to).split(/[\n{]/, 1)[0];
  return header?.trim();
}

/** Creates an unresolved HCL review unit for later dependency linking. */
function hclUnit(
  file: SourceFile,
  kind: UnitKind,
  name: string,
  range: SourceRange,
  declarationFrom: number,
  references: string[],
  aliases: string[],
  stableName: string,
): PendingUnit {
  const unit = makeUnit(
    file,
    "hcl",
    kind,
    name,
    range,
    [],
    complexityOf(file.content.slice(declarationFrom, range.to)),
    stableName,
  );
  return {
    unit: {
      ...unit,
      signature: unitSignature(file.content, declarationFrom, range.to),
    },
    aliases,
    references,
  };
}

/** Produces a stable block identity from its type, labels, and occurrence. */
function blockIdentity(block: HclBlock, occurrence: number) {
  const labels = block.labels.join(".");
  return `${block.type}:${labels || occurrence}`;
}

/** Reads a Terraform provider alias declared directly in a provider block. */
function providerAlias(source: string, block: HclBlock) {
  const body = source.slice(block.opening + 1, block.to - 1);
  return /^\s*alias\s*=\s*"([^"\\]+)"/m.exec(body)?.[1];
}

/** Maps an HCL block to its user-facing unit kind, name, and aliases. */
function blockPresentation(
  source: string,
  path: string,
  block: HclBlock,
  occurrence: number,
  parentName?: string,
) {
  const [first = "", second = ""] = block.labels;
  const testFile = path.toLowerCase().endsWith(".tftest.hcl");
  let kind: UnitKind = "module";
  let name: string;
  let aliases: string[] = [];
  if (testFile && ["run", "assert"].includes(block.type)) {
    kind = "test";
    name =
      block.type === "run"
        ? `Run ${first || occurrence}`
        : `Assertion ${occurrence}`;
  } else if (
    testFile &&
    (block.type === "provider" ||
      block.type === "mock_provider" ||
      block.type === "variables" ||
      block.type.startsWith("override_"))
  ) {
    kind = "test_hook";
    name = `${block.type.replaceAll("_", " ")} ${first}`.trim();
  } else if (testFile && block.type === "terraform") {
    kind = "test_suite";
    name = "Terraform test configuration";
  } else {
    switch (block.type) {
      case "terraform":
        name = "Terraform configuration";
        break;
      case "required_providers":
        name = "Required providers";
        break;
      case "provider": {
        const alias = providerAlias(source, block);
        const qualified = [first, alias].filter(Boolean).join(".");
        name = `Provider ${qualified || occurrence}`;
        aliases = qualified ? [`provider.${qualified}`] : [];
        break;
      }
      case "variable":
        kind = "variable";
        name = `Variable ${first || occurrence}`;
        aliases = first ? [`var.${first}`] : [];
        break;
      case "output":
        kind = "constant";
        name = `Output ${first || occurrence}`;
        aliases = first ? [`output.${first}`] : [];
        break;
      case "module":
        name = `Module ${first || occurrence}`;
        aliases = first ? [`module.${first}`] : [];
        break;
      case "resource":
        name =
          [first, second].filter(Boolean).join(".") || `Resource ${occurrence}`;
        aliases = first && second ? [`${first}.${second}`] : [];
        break;
      case "data":
        name = `Data ${[first, second].filter(Boolean).join(".") || occurrence}`;
        aliases = first && second ? [`data.${first}.${second}`] : [];
        break;
      case "moved":
        name = `Moved mapping ${occurrence}`;
        break;
      case "import":
        name = `Import mapping ${occurrence}`;
        break;
      case "check":
        name = `Check ${first || occurrence}`;
        break;
      case "dynamic":
        name = `Dynamic ${first || occurrence}`;
        break;
      case "lifecycle":
        name = "Lifecycle rules";
        break;
      case "validation":
        name = "Input validation";
        break;
      case "precondition":
        name = "Precondition";
        break;
      case "postcondition":
        name = "Postcondition";
        break;
      case "provisioner":
        name = `Provisioner ${first || occurrence}`;
        break;
      case "connection":
        name = "Provisioner connection";
        break;
      case "assert":
        kind = "test";
        name = `Assertion ${occurrence}`;
        break;
      default:
        name =
          `${block.type.replaceAll("_", " ")} ${block.labels.join(" ")}`.trim();
    }
  }
  if (parentName) name = `${parentName} › ${name}`;
  return { kind, name, aliases };
}

/** Converts a Terraform traversal into the matching unit display name. */
function dependencyDisplayName(reference: string) {
  if (reference.startsWith("var.")) return `Variable ${reference.slice(4)}`;
  if (reference.startsWith("local.")) return `Local ${reference.slice(6)}`;
  if (reference.startsWith("module.")) return `Module ${reference.slice(7)}`;
  if (reference.startsWith("data.")) return `Data ${reference.slice(5)}`;
  return reference;
}

/** Returns blocks whose nearest structural parent is the requested block. */
function directChildren(block: HclBlock, blocks: readonly HclBlock[]) {
  return blocks.filter((candidate) => candidate.parent === block);
}

/** Checks whether a container can be split entirely into meaningful children. */
function onlyMeaningfulChildren(
  source: string,
  structural: string,
  block: HclBlock,
  children: readonly HclBlock[],
) {
  if (
    children.length === 0 ||
    !children.every((child) =>
      independentlyMeaningfulNestedBlocks.has(child.type),
    )
  ) {
    return false;
  }
  const remainder = [...structural.slice(block.opening + 1, block.to - 1)];
  for (const child of children) {
    blank(
      remainder,
      child.from - block.opening - 1,
      child.to - block.opening - 1,
    );
  }
  return remainder.join("").trim().length === 0 && source.length > 0;
}

/** Analyzes one HCL or Terraform file into native review units. */
function analyzeHcl(file: SourceFile) {
  if (isContextOnly(file.content)) return [];
  const structural = maskHclSource(file.content);
  const blocks = hclBlocks(file.content, structural);
  const roots = blocks.filter((block) => !block.parent);
  const depths = depthTable(structural);
  const pending: PendingUnit[] = [];
  const occurrenceByIdentity = new Map<string, number>();
  const resourceAliases = new Set(
    roots
      .filter(({ type, labels }) => type === "resource" && labels.length >= 2)
      .map(({ labels }) => `${labels[0]}.${labels[1]}`),
  );

  /** Allocates a deterministic occurrence for repeated block identities. */
  const occurrence = (block: HclBlock) => {
    const raw = `${block.type}:${block.labels.join(".")}`;
    const next = (occurrenceByIdentity.get(raw) ?? 0) + 1;
    occurrenceByIdentity.set(raw, next);
    return next;
  };

  for (const block of roots) {
    const blockOccurrence = occurrence(block);
    const children = directChildren(block, blocks);
    const presentation = blockPresentation(
      file.content,
      file.path,
      block,
      blockOccurrence,
    );

    if (block.type === "locals") {
      const attributes = attributesInScope(
        file.content,
        structural,
        depths,
        block.opening + 1,
        block.to - 1,
        (depths[block.opening] ?? 0) + 1,
        children,
      );
      if (attributes.length > 0) {
        attributes.forEach((attribute, index) => {
          const range = {
            from:
              index === 0
                ? documentedStart(file.content, block.declarationFrom)
                : attribute.from,
            to: index === attributes.length - 1 ? block.to : attribute.to,
          };
          const alias = `local.${attribute.name}`;
          pending.push(
            hclUnit(
              file,
              "variable",
              `Local ${attribute.name}`,
              range,
              attribute.declarationFrom,
              hclReferences(
                file.content.slice(range.from, range.to),
                resourceAliases,
              ),
              [alias],
              `local:${attribute.name}`,
            ),
          );
        });
        continue;
      }
    }

    if (onlyMeaningfulChildren(file.content, structural, block, children)) {
      children.forEach((child, index) => {
        const childOccurrence = occurrence(child);
        const childPresentation = blockPresentation(
          file.content,
          file.path,
          child,
          childOccurrence,
          presentation.name,
        );
        const next = children[index + 1];
        const range = {
          from:
            index === 0
              ? documentedStart(file.content, block.declarationFrom)
              : documentedStart(file.content, child.declarationFrom),
          to:
            index === children.length - 1
              ? block.to
              : trimEnd(
                  file.content,
                  documentedStart(
                    file.content,
                    next?.declarationFrom ?? block.to,
                  ),
                ),
        };
        pending.push(
          hclUnit(
            file,
            childPresentation.kind,
            childPresentation.name,
            range,
            child.declarationFrom,
            hclReferences(
              file.content.slice(range.from, range.to),
              resourceAliases,
            ),
            childPresentation.aliases,
            `${blockIdentity(block, blockOccurrence)}:${blockIdentity(child, childOccurrence)}`,
          ),
        );
      });
      continue;
    }

    const range = {
      from: documentedStart(file.content, block.declarationFrom),
      to: block.to,
    };
    pending.push(
      hclUnit(
        file,
        presentation.kind,
        presentation.name,
        range,
        block.declarationFrom,
        hclReferences(
          file.content.slice(range.from, range.to),
          resourceAliases,
        ),
        presentation.aliases,
        blockIdentity(block, blockOccurrence),
      ),
    );
  }

  const rootAttributes = attributesInScope(
    file.content,
    structural,
    depths,
    0,
    file.content.length,
    0,
    roots,
  );
  rootAttributes.forEach((attribute, index) => {
    const nextRoot = roots.find(
      (block) => block.from > attribute.declarationFrom,
    );
    const lastAttribute = rootAttributes[index + 1];
    const nextBoundary = [nextRoot?.from, lastAttribute?.from]
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right)[0];
    const tfvars = file.path.toLowerCase().endsWith(".tfvars");
    const range = {
      from:
        index === 0 && roots.length === 0
          ? 0
          : documentedStart(file.content, attribute.declarationFrom),
      to:
        index === rootAttributes.length - 1 && roots.length === 0
          ? file.content.length
          : trimEnd(file.content, nextBoundary ?? attribute.to),
    };
    pending.push(
      hclUnit(
        file,
        "variable",
        tfvars ? `Input ${attribute.name}` : `Setting ${attribute.name}`,
        range,
        attribute.declarationFrom,
        hclReferences(
          file.content.slice(range.from, range.to),
          resourceAliases,
        ),
        tfvars ? [`var.${attribute.name}`] : [attribute.name],
        `${tfvars ? "tfvar" : "setting"}:${attribute.name}`,
      ),
    );
  });

  if (pending.length === 0) {
    pending.push(
      hclUnit(
        file,
        "module",
        "HCL configuration",
        { from: 0, to: file.content.length },
        0,
        hclReferences(file.content, resourceAliases),
        [],
        "configuration",
      ),
    );
  }

  const aliases = new Map<string, string>();
  for (const candidate of pending) {
    for (const alias of candidate.aliases)
      aliases.set(alias, candidate.unit.stableKey);
  }
  return pending
    .sort((left, right) => left.unit.startLine - right.unit.startLine)
    .map(({ unit, aliases: ownAliases, references }) => ({
      ...unit,
      dependencies: [
        ...new Set(
          references
            .filter((reference) => !ownAliases.includes(reference))
            .map(
              (reference) =>
                aliases.get(reference) ?? dependencyDisplayName(reference),
            ),
        ),
      ],
    }));
}

export const hclAdapter: LanguageAdapter = {
  language: "hcl",
  extensions: supportedExtensions.hcl,
  isContextOnly,
  analyze: analyzeHcl,
};

export const hclParserInternals = {
  maskHclSource,
  referenceSource,
};
