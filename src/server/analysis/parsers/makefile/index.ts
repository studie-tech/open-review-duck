import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions, supportedFileNames } from "../../types";
import { makeUnit, type SourceRange } from "../shared";

export const makefileExtensions = supportedExtensions.makefile;
export const makefileFileNames = supportedFileNames.makefile;

interface MakeLine {
  from: number;
  to: number;
  text: string;
  code: string;
  recipe: boolean;
}

interface PendingUnit {
  unit: Omit<AnalyzedUnit, "depth" | "reviewOrder">;
  identity: string;
  provides?: string[];
  ownerTargets: string[];
  references: string[];
  prerequisites: string[];
  containedBy?: number;
}

interface ConfigurationItem {
  start: number;
  end: number;
  variables: VariableDeclaration[];
  conditional: boolean;
}

interface ConditionalRange {
  index: number;
  opener: number;
  end: number;
  branches: number[];
}

interface VariableDeclaration {
  name: string;
  operator: string;
  modifiers: string[];
  scopeTargets: string[];
  description: string;
}

interface RuleDeclaration {
  targets: string[];
  prerequisites: string[];
  separator: string;
  inlineRecipe: boolean;
  staticPattern?: string;
}

const builtinFunctions = new Set([
  "abspath",
  "addprefix",
  "addsuffix",
  "and",
  "basename",
  "call",
  "dir",
  "error",
  "eval",
  "file",
  "filter",
  "filter-out",
  "findstring",
  "firstword",
  "flavor",
  "foreach",
  "guile",
  "if",
  "info",
  "join",
  "lastword",
  "notdir",
  "or",
  "origin",
  "patsubst",
  "realpath",
  "shell",
  "sort",
  "strip",
  "subst",
  "suffix",
  "value",
  "warning",
  "wildcard",
  "word",
  "wordlist",
  "words",
]);

const automaticVariables = new Set([
  "@",
  "%",
  "<",
  "?",
  "^",
  "+",
  "*",
  "|",
  "@D",
  "@F",
  "*D",
  "*F",
  "%D",
  "%F",
  "<D",
  "<F",
  "^D",
  "^F",
  "+D",
  "+F",
  "?D",
  "?F",
]);

const testTargets =
  /^(?:check|checks|coverage|integration(?:-test)?|lint|spec|specs|test|tests|unit(?:-test)?|verify)(?:[-_:].*)?$/i;
const testHooks =
  /^(?:prepare|setup|teardown|fixtures?|test[-_:](?:prepare|setup|teardown))$/i;
const specialTargets = new Set([
  ".DEFAULT",
  ".DELETE_ON_ERROR",
  ".EXPORT_ALL_VARIABLES",
  ".IGNORE",
  ".INTERMEDIATE",
  ".LOW_RESOLUTION_TIME",
  ".NOTPARALLEL",
  ".ONESHELL",
  ".PHONY",
  ".PRECIOUS",
  ".SECONDARY",
  ".SECONDEXPANSION",
  ".SILENT",
  ".SUFFIXES",
]);

/** Removes a Make comment while respecting escaped hash characters. */
function stripMakeComment(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "#") continue;
    let escapes = 0;
    for (
      let cursor = index - 1;
      cursor >= 0 && text[cursor] === "\\";
      cursor -= 1
    ) {
      escapes += 1;
    }
    if (escapes % 2 === 0) return text.slice(0, index);
  }
  return text;
}

/** Detects an unescaped Make line continuation. */
function continued(text: string) {
  const material = stripMakeComment(text)
    .replace(/\r?\n$/, "")
    .trimEnd();
  let slashes = 0;
  for (
    let index = material.length - 1;
    index >= 0 && material[index] === "\\";
    index -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

/** Splits source while tracking recipe prefixes and recipe context. */
function sourceLines(source: string): MakeLine[] {
  const lines: MakeLine[] = [];
  let offset = 0;
  let recipePrefix = "\t";
  let recipeExpected = false;
  let continuingStatement = false;
  let continuingRule = false;
  for (const text of source.split(/(?<=\n)/)) {
    const from = offset;
    const to = from + text.length;
    const isRecipe: boolean = recipeExpected && text.startsWith(recipePrefix);
    const code: string = isRecipe ? text : stripMakeComment(text);
    lines.push({ from, to, text, code, recipe: isRecipe });
    const prefix = /^\s*\.RECIPEPREFIX\s*(?::=|=)\s*(\S)/.exec(code)?.[1];
    if (prefix) recipePrefix = prefix;
    if (isRecipe) {
      // Every prefixed physical line belongs to the current recipe.
    } else if (continuingStatement) {
      if (!continued(text)) {
        recipeExpected = continuingRule;
        continuingStatement = false;
        continuingRule = false;
      }
    } else if (code.trim()) {
      const isRule: boolean = parseRule(code) !== undefined;
      if (continued(text)) {
        continuingStatement = true;
        continuingRule = isRule;
        recipeExpected = false;
      } else {
        recipeExpected = isRule;
      }
    } else if (!isRecipe && !code.trim()) {
      // Blank lines do not detach recipes from their rule.
    }
    offset = to;
  }
  return lines;
}

/** Finds the final physical line of a continued statement. */
function logicalEnd(lines: MakeLine[], start: number) {
  let end = start;
  while (end + 1 < lines.length && continued(lines[end]?.text ?? "")) end += 1;
  return end;
}

/** Joins physical continuation lines into one logical statement. */
function logicalText(lines: MakeLine[], start: number, end: number) {
  return lines
    .slice(start, end + 1)
    .map(({ code }) => code.replace(/\\\s*(?:\r?\n)?$/, " "))
    .join("")
    .trim();
}

/** Converts an inclusive line span to source offsets. */
function lineRange(lines: MakeLine[], start: number, end: number): SourceRange {
  return {
    from: lines[start]?.from ?? 0,
    to: lines[end]?.to ?? lines.at(-1)?.to ?? 0,
  };
}

/** Includes an adjacent unclaimed documentation comment block. */
function documentedStart(
  lines: MakeLine[],
  declaration: number,
  occupied: boolean[],
) {
  let start = declaration;
  for (let index = declaration - 1; index >= 0; index -= 1) {
    const text = lines[index]?.text.replace(/\r?\n$/, "") ?? "";
    if (!occupied[index] && /^\s*#/.test(text)) {
      start = index;
      continue;
    }
    break;
  }
  return start;
}

/** Marks an inclusive line span as assigned to a review unit. */
function mark(occupied: boolean[], start: number, end: number) {
  for (let index = start; index <= end; index += 1) occupied[index] = true;
}

/** Splits Make words without breaking nested variable expansions. */
function splitWords(source: string) {
  const words: string[] = [];
  let current = "";
  let variableDepth = 0;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "$" && ["(", "{"].includes(source[index + 1] ?? "")) {
      variableDepth += 1;
      current += `${character}${source[index + 1]}`;
      index += 1;
      continue;
    }
    if (variableDepth > 0 && [")", "}"].includes(character)) {
      variableDepth -= 1;
      current += character;
      continue;
    }
    if (variableDepth === 0 && /\s/.test(character)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) words.push(current);
  return words;
}

/** Finds a rule colon outside escapes and variable expansions. */
function topLevelColon(source: string, from = 0) {
  const stack: string[] = [];
  let escaped = false;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "$" && ["(", "{"].includes(source[index + 1] ?? "")) {
      stack.push(source[index + 1] === "(" ? ")" : "}");
      index += 1;
      continue;
    }
    if (stack.at(-1) === character) {
      stack.pop();
      continue;
    }
    if (character === ":" && stack.length === 0) return index;
  }
  return -1;
}

/** Describes a variable's flavor and declaration modifiers. */
function variableDescription(operator: string, modifiers: readonly string[]) {
  const flavor =
    operator === ":=" || operator === "::="
      ? "simple"
      : operator === "?="
        ? "conditional"
        : operator === "+="
          ? "append"
          : operator === "!="
            ? "shell"
            : "recursive";
  return [...modifiers, flavor].join(" ");
}

/** Parses global, target-specific, and pattern-specific variables. */
function parseVariable(source: string): VariableDeclaration | undefined {
  const global =
    /^\s*((?:(?:export|override|private|unexport)\s+)*)([^\s:=+?!][^:=+?!]*?)\s*(::=|:=|\?=|\+=|!=|=)(?!=)\s*/.exec(
      source,
    );
  if (global) {
    const modifiers = (global[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const name = (global[2] ?? "").trim();
    const operator = global[3] ?? "=";
    if (name && !name.includes(":")) {
      return {
        name,
        operator,
        modifiers,
        scopeTargets: [],
        description: variableDescription(operator, modifiers),
      };
    }
  }
  const colon = topLevelColon(source);
  if (colon < 0) return undefined;
  const targets = splitWords(source.slice(0, colon));
  const scoped =
    /^\s*((?:(?:export|override|private|unexport)\s+)*)([^\s:=+?!][^:=+?!]*?)\s*(::=|:=|\?=|\+=|!=|=)(?!=)\s*/.exec(
      source.slice(colon + 1),
    );
  if (!scoped || targets.length === 0) return undefined;
  const modifiers = (scoped[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const name = (scoped[2] ?? "").trim();
  const operator = scoped[3] ?? "=";
  if (!name) return undefined;
  return {
    name,
    operator,
    modifiers,
    scopeTargets: targets,
    description: variableDescription(operator, modifiers),
  };
}

/** Parses explicit, grouped, pattern, suffix, and static-pattern rules. */
function parseRule(source: string): RuleDeclaration | undefined {
  if (parseVariable(source)) return undefined;
  const colon = topLevelColon(source);
  if (colon <= 0) return undefined;
  let separator = ":";
  let rightStart = colon + 1;
  if (source[colon - 1] === "&" && source[colon + 1] === ":") {
    separator = "&::";
    rightStart = colon + 2;
  } else if (source.slice(colon, colon + 2) === "::") {
    separator = "::";
    rightStart = colon + 2;
  } else if (source[colon - 1] === "&") {
    separator = "&:";
  }
  const targetSource = source
    .slice(0, separator.startsWith("&") ? colon - 1 : colon)
    .trim();
  const targets = splitWords(targetSource);
  if (targets.length === 0 || targets.some((target) => target.includes("=")))
    return undefined;
  const remainder = source.slice(rightStart);
  let prerequisiteSource = remainder;
  let inlineRecipe = false;
  let variableDepth = 0;
  for (let index = 0; index < remainder.length; index += 1) {
    if (
      remainder[index] === "$" &&
      ["(", "{"].includes(remainder[index + 1] ?? "")
    ) {
      variableDepth += 1;
      index += 1;
      continue;
    }
    if (variableDepth && [")", "}"].includes(remainder[index] ?? "")) {
      variableDepth -= 1;
      continue;
    }
    if (remainder[index] === ";" && variableDepth === 0) {
      prerequisiteSource = remainder.slice(0, index);
      inlineRecipe = true;
      break;
    }
  }
  const staticColon = topLevelColon(prerequisiteSource);
  const staticPattern =
    staticColon >= 0
      ? prerequisiteSource.slice(0, staticColon).trim()
      : undefined;
  if (staticColon >= 0)
    prerequisiteSource = prerequisiteSource.slice(staticColon + 1);
  const prerequisites = splitWords(prerequisiteSource)
    .filter((word) => word !== "|")
    .map((word) => word.replace(/\\ /g, " "));
  return { targets, prerequisites, separator, inlineRecipe, staticPattern };
}

/** Extracts referenced variables and callable canned recipes. */
function variableReferences(source: string) {
  const references = new Set<string>();
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$") continue;
    const next = source[index + 1] ?? "";
    if (automaticVariables.has(next)) {
      index += 1;
      continue;
    }
    if (!["(", "{"].includes(next)) {
      if (/\w/.test(next) && next !== "$") references.add(next);
      continue;
    }
    const closing = next === "(" ? ")" : "}";
    let depth = 1;
    let cursor = index + 2;
    for (; cursor < source.length && depth > 0; cursor += 1) {
      if (source[cursor] === next) depth += 1;
      if (source[cursor] === closing) depth -= 1;
    }
    const body = source.slice(index + 2, cursor - 1).trim();
    const head = body.match(/^([^\s,:]+)/)?.[1];
    if (head && !builtinFunctions.has(head) && !automaticVariables.has(head)) {
      references.add(head);
    }
    if (head === "call") {
      const callable = body
        .slice(4)
        .trim()
        .match(/^([^,\s]+)/)?.[1];
      if (callable) references.add(callable);
    }
    for (const nested of variableReferences(body)) references.add(nested);
    index = cursor - 1;
  }
  return [...references];
}

/** Recognizes mandatory and optional include directives. */
function includeDirective(source: string) {
  return /^\s*(?:-?include|sinclude)\s+\S/.test(source);
}

/** True when the file contains only comments and Make include directives. */
export function isContextOnly(source: string) {
  const lines = sourceLines(source);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const code = line.code.trim();
    if (!code || /^\s*#/.test(line.text)) continue;
    const end = logicalEnd(lines, index);
    if (!includeDirective(logicalText(lines, index, end))) return false;
    index = end;
  }
  return true;
}

/** Matches nested conditionals and reserves their directive lines. */
function conditionalRanges(lines: MakeLine[], occupied: boolean[]) {
  const ranges: ConditionalRange[] = [];
  const stack: Array<{ index: number; opener: number; branches: number[] }> =
    [];
  let nextIndex = 0;
  lines.forEach((line, lineIndex) => {
    if (line.recipe) return;
    const code = line.code.trim();
    if (/^if(?:eq|neq|def|ndef)\b/.test(code)) {
      stack.push({ index: nextIndex, opener: lineIndex, branches: [] });
      nextIndex += 1;
      occupied[lineIndex] = true;
      return;
    }
    if (/^else\b/.test(code) && stack.length > 0) {
      stack.at(-1)?.branches.push(lineIndex);
      occupied[lineIndex] = true;
      return;
    }
    if (/^endif\b/.test(code) && stack.length > 0) {
      const opener = stack.pop();
      occupied[lineIndex] = true;
      if (opener) ranges.push({ ...opener, end: lineIndex });
    }
  });
  return ranges;
}

/** Classifies test, setup, special, and ordinary targets. */
function ruleKind(targets: readonly string[]): UnitKind {
  if (targets.some((target) => testTargets.test(target))) return "test";
  if (targets.some((target) => testHooks.test(target))) return "test_hook";
  if (targets.every((target) => specialTargets.has(target))) return "module";
  return "function";
}

/** Finds concrete targets invoked by recursive Make commands. */
function recursiveMakeTargets(source: string) {
  const targets = new Set<string>();
  for (const match of source.matchAll(
    /(?:^|\n|[;&|])\s*(?:[-+@]\s*)?(?:\$\(MAKE\)|\$\{MAKE\}|\bmake)\s+([^\n;&|]+)/g,
  )) {
    for (const word of splitWords(match[1] ?? "")) {
      if (word.startsWith("-") || word.includes("=") || word.startsWith("$(")) {
        continue;
      }
      targets.add(word);
    }
  }
  return [...targets];
}

/** Produces a compact display name for a parsed rule. */
function ruleName(rule: RuleDeclaration) {
  if (rule.targets[0] === ".PHONY") return "Phony targets";
  if (rule.targets.length === 1) return rule.targets[0] ?? "anonymous target";
  return rule.targets.join(rule.separator.startsWith("&") ? " & " : " + ");
}

/** Recognizes visual section dividers that are not executable build targets. */
function isDecorativeSectionRule(rule: RuleDeclaration) {
  return (
    rule.prerequisites.length === 0 &&
    rule.targets.length > 0 &&
    /^-{3,}[^$%]*-{3,}$/.test(rule.targets.join(" "))
  );
}

/** Finds the next meaningful Make rule after a metadata declaration. */
function nextRule(lines: MakeLine[], after: number) {
  for (let index = after + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.recipe || !line.code.trim()) continue;
    const end = logicalEnd(lines, index);
    const parsed = parseRule(logicalText(lines, index, end));
    if (parsed && !isDecorativeSectionRule(parsed)) {
      return { index, rule: parsed };
    }
    if (!/^\s*#/.test(line.text)) return undefined;
    index = end;
  }
  return undefined;
}

/** Tests whether the gap between declarations contains only comments or space. */
function onlyTriviaBetween(lines: MakeLine[], from: number, to: number) {
  for (let index = from; index <= to; index += 1) {
    const line = lines[index];
    if (line?.code.trim() && !/^\s*#/.test(line.text)) return false;
  }
  return true;
}

/** Collects variable declarations from a conditional that contains no rules. */
function pureConditionalConfiguration(
  lines: MakeLine[],
  conditional: ConditionalRange,
) {
  const variables: VariableDeclaration[] = [];
  for (
    let index = conditional.opener + 1;
    index < conditional.end;
    index += 1
  ) {
    const line = lines[index];
    if (!line?.code.trim() || /^\s*#/.test(line.text)) continue;
    const code = line.code.trim();
    if (/^(?:else\b|if(?:eq|neq|def|ndef)\b|endif\b)/.test(code)) continue;
    const end = logicalEnd(lines, index);
    const variable = parseVariable(logicalText(lines, index, end));
    if (!variable) return undefined;
    variables.push(variable);
    index = end;
  }
  return variables.length > 0 ? variables : undefined;
}

/** Groups adjacent settings around pure conditional branches into one concept. */
function configurationGroups(
  lines: MakeLine[],
  conditionals: readonly ConditionalRange[],
) {
  const conditionalByOpener = new Map(
    conditionals.map((conditional) => [conditional.opener, conditional]),
  );
  const items: ConfigurationItem[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const conditional = conditionalByOpener.get(index);
    if (conditional) {
      const variables = pureConditionalConfiguration(lines, conditional);
      if (variables) {
        items.push({
          start: conditional.opener,
          end: conditional.end,
          variables,
          conditional: true,
        });
        index = conditional.end;
        continue;
      }
    }
    const line = lines[index];
    if (!line || line.recipe || !line.code.trim()) continue;
    const end = logicalEnd(lines, index);
    const variable = parseVariable(logicalText(lines, index, end));
    if (variable) {
      items.push({
        start: index,
        end,
        variables: [variable],
        conditional: false,
      });
      index = end;
    }
  }

  const groups: ConfigurationItem[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (
      previous &&
      onlyTriviaBetween(lines, previous.end + 1, item.start - 1)
    ) {
      previous.end = item.end;
      previous.variables.push(...item.variables);
      previous.conditional ||= item.conditional;
    } else {
      groups.push({ ...item, variables: [...item.variables] });
    }
  }
  return groups.filter(({ conditional }) => conditional);
}

/** Estimates complexity from prerequisites and control functions. */
function complexity(source: string, prerequisiteCount = 0) {
  return Math.max(
    1,
    1 +
      prerequisiteCount +
      (source.match(
        /\$\((?:call|eval|foreach|if)\b|\b(?:&&|\|\||for|if|while)\b/g,
      )?.length ?? 0),
  );
}

/** Extracts Make review units and resolves their local dependencies. */
function analyzeMakefile(file: SourceFile) {
  if (!file.content.trim() || isContextOnly(file.content)) return [];
  const lines = sourceLines(file.content);
  const occupied = Array.from({ length: lines.length }, () => false);
  const pending: PendingUnit[] = [];
  const conditionals = conditionalRanges(lines, occupied);
  const groupedConfigurationLines = Array.from(
    { length: lines.length },
    () => false,
  );
  const identityCounts = new Map<string, number>();
  /** Disambiguates repeated assignments and double-colon rules. */
  const uniqueIdentity = (base: string) => {
    const count = identityCounts.get(base) ?? 0;
    identityCounts.set(base, count + 1);
    return count === 0 ? base : `${base}:${count + 1}`;
  };

  for (const group of configurationGroups(lines, conditionals)) {
    const start = documentedStart(lines, group.start, occupied);
    const range = lineRange(lines, start, group.end);
    const provided = [...new Set(group.variables.map(({ name }) => name))];
    const scopedTargets = [
      ...new Set(group.variables.flatMap(({ scopeTargets }) => scopeTargets)),
    ];
    const name = start === 0 ? "Build configuration" : "Make configuration";
    const identity = uniqueIdentity(
      `configuration:${provided.join("+")}:${start + 1}`,
    );
    const unit = makeUnit(
      file,
      "makefile",
      "module",
      name,
      range,
      [],
      complexity(file.content.slice(range.from, range.to)),
      identity,
    );
    pending.push({
      unit: {
        ...unit,
        signature: `${provided.length} settings with conditional branches`,
      },
      identity,
      provides: provided,
      ownerTargets: scopedTargets,
      references: variableReferences(file.content.slice(range.from, range.to)),
      prerequisites: [],
    });
    mark(occupied, start, group.end);
    for (let index = start; index <= group.end; index += 1) {
      groupedConfigurationLines[index] = true;
    }
  }

  let pendingRulePrefix: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || occupied[index] || line.recipe || !line.code.trim()) continue;
    const logicalLast = logicalEnd(lines, index);
    const statement = logicalText(lines, index, logicalLast);
    if (includeDirective(statement)) {
      mark(occupied, index, logicalLast);
      index = logicalLast;
      continue;
    }

    const define =
      /^\s*((?:(?:export|override|private)\s+)*)define\s+([^\s:=]+)(?:\s*(::=|:=|\?=|\+=|=))?/.exec(
        statement,
      );
    if (define) {
      let depth = 1;
      let end = logicalLast + 1;
      for (; end < lines.length; end += 1) {
        if (
          /^\s*(?:(?:export|override|private)\s+)*define\b/.test(
            lines[end]?.code ?? "",
          )
        )
          depth += 1;
        if (/^\s*endef\b/.test(lines[end]?.code ?? "")) depth -= 1;
        if (depth === 0) break;
      }
      end = Math.min(end, lines.length - 1);
      const start = documentedStart(lines, index, occupied);
      const name = define[2] ?? "anonymous define";
      const modifiers = (define[1] ?? "").trim().split(/\s+/).filter(Boolean);
      const identity = uniqueIdentity(`define:${name}`);
      const range = lineRange(lines, start, end);
      const unit = makeUnit(
        file,
        "makefile",
        "function",
        `${name} (canned recipe)`,
        range,
        [],
        complexity(file.content.slice(range.from, range.to)),
        identity,
      );
      pending.push({
        unit: {
          ...unit,
          signature: `${modifiers.join(" ")}${modifiers.length ? " " : ""}define ${name}`,
        },
        identity: name,
        ownerTargets: [],
        references: variableReferences(
          file.content.slice(range.from, range.to),
        ),
        prerequisites: [],
      });
      mark(occupied, start, end);
      index = end;
      continue;
    }

    const variable = parseVariable(statement);
    if (variable) {
      const start = documentedStart(lines, index, occupied);
      const identityBase = `variable:${variable.scopeTargets.join("+")}:${variable.name}:${variable.description}`;
      const identity = uniqueIdentity(identityBase);
      const scope = variable.scopeTargets.length
        ? `${variable.scopeTargets.join(" + ")}: `
        : "";
      const suffix =
        variable.description === "recursive"
          ? ""
          : ` · ${variable.description}`;
      const range = lineRange(lines, start, logicalLast);
      const unit = makeUnit(
        file,
        "makefile",
        /^[A-Z0-9_.-]+$/.test(variable.name) ? "constant" : "variable",
        `${scope}${variable.name}${suffix}`,
        range,
        [],
        complexity(statement),
        identity,
      );
      pending.push({
        unit: { ...unit, signature: statement.split("\n", 1)[0] },
        identity: variable.name,
        provides: [variable.name],
        ownerTargets: variable.scopeTargets,
        references: variableReferences(statement),
        prerequisites: [],
      });
      mark(occupied, start, logicalLast);
      index = logicalLast;
      continue;
    }

    const rule = parseRule(statement);
    if (rule) {
      if (isDecorativeSectionRule(rule)) {
        pendingRulePrefix = Math.min(
          pendingRulePrefix ?? index,
          documentedStart(lines, index, occupied),
        );
        mark(occupied, index, logicalLast);
        index = logicalLast;
        continue;
      }
      if (rule.targets.length === 1 && rule.targets[0] === ".PHONY") {
        const following = nextRule(lines, logicalLast);
        const declared = new Set(rule.prerequisites);
        if (
          following &&
          declared.size === following.rule.targets.length &&
          following.rule.targets.every((target) => declared.has(target))
        ) {
          pendingRulePrefix = Math.min(
            pendingRulePrefix ?? index,
            documentedStart(lines, index, occupied),
          );
          mark(occupied, index, logicalLast);
          index = logicalLast;
          continue;
        }
      }
      let end = logicalLast;
      for (let cursor = logicalLast + 1; cursor < lines.length; cursor += 1) {
        const recipeLine = lines[cursor];
        if (!recipeLine) break;
        if (recipeLine.recipe || !recipeLine.code.trim()) {
          if (recipeLine.recipe) end = cursor;
          continue;
        }
        break;
      }
      const start = Math.min(
        documentedStart(lines, index, occupied),
        pendingRulePrefix ?? index,
      );
      pendingRulePrefix = undefined;
      const range = lineRange(lines, start, end);
      const identity = uniqueIdentity(
        `rule:${rule.targets.join("+")}:${rule.separator}:${rule.staticPattern ?? ""}`,
      );
      const unit = makeUnit(
        file,
        "makefile",
        ruleKind(rule.targets),
        ruleName(rule),
        range,
        [],
        complexity(
          file.content.slice(range.from, range.to),
          rule.prerequisites.length,
        ),
        identity,
      );
      pending.push({
        unit: { ...unit, signature: statement.split(";", 1)[0]?.trim() },
        identity: rule.targets.join("+"),
        ownerTargets: rule.targets,
        references: variableReferences(
          file.content.slice(lines[index]?.from ?? range.from, range.to),
        ),
        prerequisites: [
          ...rule.prerequisites,
          ...recursiveMakeTargets(
            file.content.slice(lines[index]?.from ?? range.from, range.to),
          ),
        ],
      });
      mark(occupied, start, end);
      index = end;
    }
  }

  for (const conditional of conditionals) {
    if (groupedConfigurationLines[conditional.opener]) continue;
    const opener = lines[conditional.opener];
    if (!opener) continue;
    const start = documentedStart(lines, conditional.opener, occupied);
    const heading = opener.code.trim().replace(/\s+/g, " ");
    const identity = `conditional:${conditional.index}:${heading}`;
    const range = lineRange(lines, start, conditional.opener);
    pending.push({
      unit: makeUnit(
        file,
        "makefile",
        "module",
        `Conditional: ${heading}`,
        range,
        [],
        1,
        identity,
      ),
      identity,
      ownerTargets: [],
      references: variableReferences(opener.code),
      prerequisites: [],
      containedBy: conditional.index,
    });
    mark(occupied, start, conditional.opener);
  }

  let setupIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index];
    if (!first || occupied[index] || first.recipe || !first.code.trim())
      continue;
    let end = logicalEnd(lines, index);
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (!next || occupied[end + 1] || next.recipe || !next.code.trim()) break;
      end = logicalEnd(lines, end + 1);
    }
    const start = documentedStart(lines, index, occupied);
    const range = lineRange(lines, start, end);
    const heading = [
      ...file.content.slice(range.from, first.from).matchAll(/^\s*#\s*(.+)$/gm),
    ]
      .at(-1)?.[1]
      ?.trim();
    const name =
      heading ||
      (setupIndex === 0 ? "Make setup" : `Make setup ${setupIndex + 1}`);
    const identity = `setup:${setupIndex}:${name}`;
    pending.push({
      unit: makeUnit(
        file,
        "makefile",
        "module",
        name,
        range,
        [],
        complexity(file.content.slice(range.from, range.to)),
        identity,
      ),
      identity,
      ownerTargets: [],
      references: variableReferences(file.content.slice(first.from, range.to)),
      prerequisites: [],
    });
    mark(occupied, start, end);
    setupIndex += 1;
    index = end;
  }

  const variables = new Map<string, string[]>();
  const targets = new Map<string, string[]>();
  const targetVariables = new Map<string, string[]>();
  for (const item of pending) {
    if (["constant", "variable"].includes(item.unit.kind)) {
      for (const provided of item.provides ?? [item.identity]) {
        variables.set(provided, [
          ...(variables.get(provided) ?? []),
          item.unit.stableKey,
        ]);
      }
    } else if (item.provides) {
      for (const provided of item.provides) {
        variables.set(provided, [
          ...(variables.get(provided) ?? []),
          item.unit.stableKey,
        ]);
      }
    }
    for (const target of item.ownerTargets) {
      targets.set(target, [
        ...(targets.get(target) ?? []),
        item.unit.stableKey,
      ]);
      if (["constant", "variable"].includes(item.unit.kind)) {
        targetVariables.set(target, [
          ...(targetVariables.get(target) ?? []),
          item.unit.stableKey,
        ]);
      }
    }
    if (item.unit.name.endsWith("(canned recipe)")) {
      variables.set(item.identity, [
        ...(variables.get(item.identity) ?? []),
        item.unit.stableKey,
      ]);
    }
  }
  return pending
    .map((item) => {
      const prerequisiteDependencies = item.prerequisites.flatMap(
        (prerequisite) => targets.get(prerequisite) ?? [],
      );
      const variableDependencies = item.references.flatMap(
        (reference) => variables.get(reference) ?? [],
      );
      const targetVariableDependencies = item.ownerTargets.flatMap((target) =>
        (targetVariables.get(target) ?? []).filter(
          (key) => key !== item.unit.stableKey,
        ),
      );
      const conditionalDependencies =
        item.containedBy === undefined
          ? []
          : pending
              .filter(
                (candidate) =>
                  candidate !== item &&
                  candidate.unit.startLine > item.unit.startLine &&
                  candidate.unit.startLine <=
                    (conditionals.find(
                      ({ index }) => index === item.containedBy,
                    )?.end ?? -1) +
                      1,
              )
              .map(({ unit }) => unit.stableKey);
      return {
        ...item.unit,
        dependencies: [
          ...new Set([
            ...item.unit.dependencies,
            ...prerequisiteDependencies,
            ...variableDependencies,
            ...targetVariableDependencies,
            ...conditionalDependencies,
          ]),
        ].filter((key) => key !== item.unit.stableKey),
      };
    })
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );
}

export const makefileAdapter: LanguageAdapter = {
  language: "makefile",
  extensions: makefileExtensions,
  fileNames: makefileFileNames,
  isContextOnly,
  analyze: analyzeMakefile,
};

export const makefileParserInternals = {
  parseRule,
  parseVariable,
  stripMakeComment,
  variableReferences,
  recursiveMakeTargets,
};
