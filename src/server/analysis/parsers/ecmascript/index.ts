import type { SyntaxNode, Tree } from "@lezer/common";
import { parser as javascriptParser } from "@lezer/javascript";
import {
  isImportOnlySource,
  parseImportReferences,
} from "~/lib/import-navigation";
import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import {
  callArguments,
  callSegments,
  containsNode,
  descendants,
  directChildren,
  hasCallArgument,
  hasTestCallback,
  identifier,
  isModuleLevelVariable,
  isSourceTrivia,
  isTestLikePath,
  javascriptDeclarationNode,
  lineAt,
  makeUnit,
  nodeDescendants,
  nodeKey,
  qualifiedName,
  references,
  type SourceRange,
  testCallLabel,
  textOf,
} from "../shared";

type TestCallRole = "suite" | "test" | "hook";
const largeDeclarationLineThreshold = 120;

interface DetectedTestCall {
  node: import("@lezer/common").SyntaxNode;
  role: TestCallRole;
  label: string;
  callee: string;
}

const testNames = new Set([
  "it",
  "test",
  "specify",
  "fit",
  "xit",
  "xtest",
  "bench",
  "benchmark",
]);
const suiteNames = new Set([
  "describe",
  "suite",
  "context",
  "module",
  "fdescribe",
  "xdescribe",
]);
const hookNames = new Set([
  "before",
  "after",
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
  "setup",
  "teardown",
  "suiteSetup",
  "suiteTeardown",
]);
const testModifiers = new Set([
  "only",
  "skip",
  "todo",
  "concurrent",
  "serial",
  "fails",
  "failing",
  "fixme",
  "each",
]);
const suiteModifiers = new Set(["only", "skip", "each", "serial", "parallel"]);
const testModules = [
  /^(?:vitest|node:test|bun:test|mocha|ava|tape|tap|uvu)$/,
  /^(?:@jest\/globals|@playwright\/test|@playwright\/experimental-ct-)/,
  /^(?:jasmine|qunit|cypress)/,
];

/** Returns direct child nodes matching one of the requested syntax names. */

function javascriptTestBindings(file: SourceFile, language: string) {
  const bindings = new Map<string, string>();
  for (const reference of parseImportReferences(file.content, language)) {
    if (!testModules.some((pattern) => pattern.test(reference.specifier))) {
      continue;
    }
    const imported = reference.kind === "default" ? "test" : reference.imported;
    if (
      testNames.has(imported) ||
      suiteNames.has(imported) ||
      hookNames.has(imported)
    ) {
      bindings.set(reference.local, imported);
    }
  }
  return bindings;
}

/** Classifies a JavaScript call as a test, suite, or lifecycle hook. */
function javascriptTestCall(
  file: SourceFile,
  node: SyntaxNode,
  bindings: ReadonlyMap<string, string>,
) {
  const segments = callSegments(file.content, node);
  if (!segments.length) return undefined;
  const first = segments[0] ?? "";
  const last = segments.at(-1) ?? "";
  const importedName = bindings.get(first);
  const pathAllowsGlobals = isTestLikePath(file.path);
  let canonical = importedName;
  if (!canonical && pathAllowsGlobals) {
    canonical =
      testNames.has(first) || suiteNames.has(first) || hookNames.has(first)
        ? first
        : testNames.has(last) || suiteNames.has(last) || hookNames.has(last)
          ? last
          : undefined;
  }
  if (!canonical && ["Deno", "Bun"].includes(first) && testNames.has(last)) {
    canonical = last;
  }
  if (!canonical) return undefined;
  const memberRole = segments
    .slice(1)
    .find(
      (segment) =>
        suiteNames.has(segment) ||
        hookNames.has(segment) ||
        testNames.has(segment),
    );
  if (memberRole) canonical = memberRole;
  const role: TestCallRole = testNames.has(canonical)
    ? "test"
    : suiteNames.has(canonical)
      ? "suite"
      : "hook";
  const modifiers = segments.filter(
    (segment) =>
      segment !== first &&
      segment !== canonical &&
      !suiteNames.has(segment) &&
      !hookNames.has(segment) &&
      !testNames.has(segment),
  );
  if (
    (role === "test" &&
      modifiers.some((modifier) => !testModifiers.has(modifier))) ||
    (role === "suite" &&
      modifiers.some((modifier) => !suiteModifiers.has(modifier))) ||
    (role === "hook" && modifiers.length > 0)
  ) {
    return undefined;
  }
  const label = testCallLabel(file.content, node);
  const callback = hasTestCallback(node);
  const objectArguments = Boolean(
    callArguments(node) &&
      directChildren(
        callArguments(node) as SyntaxNode,
        new Set(["ObjectExpression"]),
      ).length,
  );
  if (role === "suite" && !callback) return undefined;
  if (role === "hook" && !callback && !hasCallArgument(node)) {
    return undefined;
  }
  if (role === "test" && modifiers.includes("each") && !callback) {
    return undefined;
  }
  if (role === "test" && !callback && !label && !objectArguments) {
    return undefined;
  }
  const callee = segments.join(".");
  return {
    node,
    role,
    callee,
    label:
      label ??
      (role === "hook"
        ? canonical.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
        : `${callee} at line ${lineAt(file.content, node.from)}`),
  } satisfies DetectedTestCall;
}

/** Returns the outer statement used as the visible source for a test call. */
function testCallSourceNode(node: SyntaxNode) {
  return node.parent?.name === "ExpressionStatement" ? node.parent : node;
}

/** Includes a contiguous explanatory line-comment immediately above a range. */
function withLeadingLineComment(source: string, range: SourceRange) {
  const before = source.slice(0, range.from);
  const match =
    /(?:^|\n)([ \t]*\/\/[^\n]*(?:\n[ \t]*\/\/[^\n]*)*)\n[ \t]*$/.exec(before);
  if (!match?.[1]) return range;
  return {
    from: before.length - match[0].length + (match[0].startsWith("\n") ? 1 : 0),
    to: range.to,
  };
}

/** Returns a concise semantic label from a leading line comment. */
function leadingLineCommentLabel(source: string, range: SourceRange) {
  const expanded = withLeadingLineComment(source, range);
  if (expanded.from === range.from) return undefined;
  return source
    .slice(expanded.from, range.from)
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Finds the outer object initializer owned by a module-level variable. */
function outerVariableObject(node: SyntaxNode) {
  return nodeDescendants(node, new Set(["ObjectExpression"])).find(
    (candidate) => {
      let parent = candidate.parent;
      while (parent && parent !== node) {
        if (parent.name === "ObjectExpression") return false;
        parent = parent.parent;
      }
      return parent === node;
    },
  );
}

/** Checks that a call executes directly inside the owning function body. */
function directlyInsideFunction(call: SyntaxNode, owner: SyntaxNode) {
  let parent = call.parent;
  while (parent && parent !== owner) {
    if (
      ["ArrowFunction", "FunctionExpression", "FunctionDeclaration"].includes(
        parent.name,
      )
    ) {
      return false;
    }
    parent = parent.parent;
  }
  return parent === owner;
}

/** Reads the direct key of an object property without scanning its body. */
function javascriptPropertyName(source: string, property: SyntaxNode) {
  const definition = directChildren(
    property,
    new Set(["PropertyDefinition", "PropertyName"]),
  )[0];
  return definition ? textOf(source, definition) : identifier(source, property);
}

/** Creates focused properties and hooks inside otherwise oversized declarations. */
function javascriptNestedLogicUnits(
  file: SourceFile,
  language: "javascript" | "typescript",
  declarationNodes: readonly SyntaxNode[],
) {
  const units: Array<Omit<AnalyzedUnit, "depth" | "reviewOrder">> = [];
  for (const declaration of declarationNodes) {
    const declarationRange = javascriptDeclarationNode(
      file.content,
      declaration,
    );
    if (
      lineAt(file.content, declarationRange.to) -
        lineAt(file.content, declarationRange.from) <
      largeDeclarationLineThreshold
    ) {
      continue;
    }
    const ownerName = identifier(file.content, declaration);
    const object = outerVariableObject(declaration);
    if (object) {
      for (const property of directChildren(object, new Set(["Property"]))) {
        const propertyName = javascriptPropertyName(file.content, property);
        const range = withLeadingLineComment(file.content, property);
        const source = textOf(file.content, range);
        units.push(
          makeUnit(
            file,
            language,
            /(?:=>|\bfunction\b|\.(?:query|mutation|subscription)\s*\()/.test(
              source,
            )
              ? "method"
              : "constant",
            `${ownerName} › ${propertyName}`,
            range,
            references(file.content, property, [ownerName, propertyName]).map(
              (dependency) => `${file.path}:${dependency}`,
            ),
            1 +
              (source.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g)
                ?.length ?? 0),
            `${ownerName}.${propertyName}`,
          ),
        );
      }
    }

    const ownerFunction =
      declaration.name === "FunctionDeclaration"
        ? declaration
        : directChildren(
            declaration,
            new Set(["ArrowFunction", "FunctionExpression"]),
          )[0];
    if (!ownerFunction) continue;
    const hookCounts = new Map<string, number>();
    for (const call of nodeDescendants(
      ownerFunction,
      new Set(["CallExpression"]),
    )) {
      const callee = callSegments(file.content, call).at(-1);
      if (
        !callee ||
        !/^use[A-Z]\w*$/.test(callee) ||
        !hasTestCallback(call) ||
        !directlyInsideFunction(call, ownerFunction)
      ) {
        continue;
      }
      const occurrence = (hookCounts.get(callee) ?? 0) + 1;
      hookCounts.set(callee, occurrence);
      const statement = testCallSourceNode(call);
      const range = withLeadingLineComment(file.content, statement);
      const comment = leadingLineCommentLabel(file.content, statement);
      const name = [
        ownerName,
        callee,
        comment && comment.length <= 80 ? comment : undefined,
      ]
        .filter(Boolean)
        .join(" › ");
      const source = textOf(file.content, range);
      units.push(
        makeUnit(
          file,
          language,
          "method",
          name,
          range,
          references(file.content, call, callee).map(
            (dependency) => `${file.path}:${dependency}`,
          ),
          1 +
            (source.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g)
              ?.length ?? 0),
          `${ownerName}.${callee}:${occurrence}`,
        ),
      );
    }
  }
  return units;
}

/** Returns only the declaration header for a JavaScript test suite. */
function javascriptSuiteHeader(node: SyntaxNode): SourceRange {
  const argumentsNode = callArguments(node);
  const callback = argumentsNode
    ? directChildren(
        argumentsNode,
        new Set(["ArrowFunction", "FunctionExpression"]),
      )[0]
    : undefined;
  const body = callback
    ? directChildren(callback, new Set(["Block"]))[0]
    : undefined;
  return body ? { from: node.from, to: body.from + 1 } : node;
}

/** Creates test and hook units while retaining suites as naming metadata. */
function javascriptTestUnits(
  file: SourceFile,
  language: "javascript" | "typescript",
  tree: Tree,
) {
  const bindings = javascriptTestBindings(file, language);
  const detected = new Map<string, DetectedTestCall>();
  for (const node of descendants(tree, new Set(["CallExpression"]))) {
    const call = javascriptTestCall(file, node, bindings);
    if (call) detected.set(nodeKey(node), call);
  }
  const reviewCalls = [...detected.values()].flatMap((call) => {
    const suites: string[] = [];
    let parent = call.node.parent;
    while (parent) {
      const suite = detected.get(nodeKey(parent));
      if (suite?.role === "suite") suites.unshift(suite.label);
      parent = parent.parent;
    }
    const name = [...suites, call.label].join(" › ");
    if (call.role === "suite") return [];
    const node = testCallSourceNode(call.node);
    const source = textOf(file.content, node);
    return [
      {
        call,
        suites,
        name,
        node,
        dependencies: references(file.content, call.node, call.callee).map(
          (dependency) => `${file.path}:${dependency}`,
        ),
        complexity:
          1 +
          (source.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g)?.length ??
            0),
      },
    ];
  });
  const groups: (typeof reviewCalls)[] = [];
  for (const reviewCall of reviewCalls) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const sharesLifecycle = Boolean(
      current &&
        previous &&
        reviewCall.call.role === "hook" &&
        previous.call.role === "hook" &&
        reviewCall.suites.join("\0") === previous.suites.join("\0") &&
        isSourceTrivia(
          file.content.slice(previous.node.to, reviewCall.node.from),
        ),
    );
    if (current && sharesLifecycle) current.push(reviewCall);
    else groups.push([reviewCall]);
  }
  const units = groups.map((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) throw new Error("Test call group cannot be empty");
    const lifecycle = group.length > 1 && first.call.role === "hook";
    const name = lifecycle
      ? [...first.suites, "Test lifecycle"].join(" › ")
      : first.name;
    return makeUnit(
      file,
      language,
      first.call.role === "test" ? "test" : "test_hook",
      name,
      { from: first.node.from, to: last.node.to },
      [...new Set(group.flatMap(({ dependencies }) => dependencies))],
      group.reduce((total, { complexity }) => total + complexity, 0),
      lifecycle
        ? `hook:${name}:${group.map(({ call }) => call.callee).join("+")}`
        : `${first.call.role}:${name}:${first.call.callee}`,
    );
  });
  return { units, detected };
}

/** Returns the direct statement beneath a script node. */
function topLevelStatement(node: SyntaxNode) {
  let current = node;
  while (current.parent && current.parent.name !== "Script") {
    current = current.parent;
  }
  return current.parent?.name === "Script" ? current : undefined;
}

/** Checks whether source between syntax nodes contains only ignorable trivia. */

function importGroups(source: string, imports: readonly SyntaxNode[]) {
  const groups: Array<{ from: number; to: number }> = [];
  for (const node of imports) {
    const current = groups.at(-1);
    const between = current ? source.slice(current.to, node.from) : "";
    if (current && isSourceTrivia(between)) {
      current.to = node.to;
    } else {
      groups.push({ from: node.from, to: node.to });
    }
  }
  return groups;
}

/** Creates focused units for imports and setup statements in a test module. */
function javascriptTestSetupUnits(
  file: SourceFile,
  language: "javascript" | "typescript",
  tree: Tree,
  detected: ReadonlyMap<string, DetectedTestCall>,
) {
  const covered = new Set<number>();
  for (const call of detected.values()) {
    const statement = topLevelStatement(call.node);
    if (statement) covered.add(statement.from);
  }
  const declarationNames = new Set([
    "FunctionDeclaration",
    "ClassDeclaration",
    "InterfaceDeclaration",
    "TypeAliasDeclaration",
    "EnumDeclaration",
    "NamespaceDeclaration",
    "VariableDeclaration",
  ]);
  const topLevel = directChildren(tree.topNode);
  const imports: SyntaxNode[] = [];
  const setup: SyntaxNode[] = [];
  for (const node of topLevel) {
    if (covered.has(node.from)) continue;
    if (node.name === "ImportDeclaration") {
      imports.push(node);
      continue;
    }
    if (node.name.endsWith("Comment")) continue;
    if (
      declarationNames.has(node.name) ||
      (node.name === "ExportDeclaration" &&
        containsNode(node, declarationNames))
    ) {
      continue;
    }
    if (textOf(file.content, node).trim()) setup.push(node);
  }
  const units: Array<Omit<AnalyzedUnit, "depth" | "reviewOrder">> = [];
  const foldedSetup = new Set<number>();
  const topLevelSuites = [...detected.values()]
    .filter(
      (call) =>
        call.role === "suite" &&
        topLevelStatement(call.node)?.from === call.node.from,
    )
    .map((call) => ({
      from: call.node.from,
      to: javascriptSuiteHeader(call.node).to,
    }));
  const topLevelHooks = [...detected.values()].flatMap((call) => {
    if (call.role !== "hook" || hasTestCallback(call.node)) return [];
    const statement = topLevelStatement(call.node);
    if (!statement) return [];
    return [{ from: statement.from, to: statement.to }];
  });
  for (const [index, group] of importGroups(file.content, imports).entries()) {
    const setupRange = {
      from:
        index === 0 && isSourceTrivia(file.content.slice(0, group.from))
          ? 0
          : group.from,
      to: group.to,
    };
    const candidates = [
      ...setup.map((node) => ({
        kind: "setup" as const,
        from: node.from,
        to: node.to,
      })),
      ...topLevelSuites.map((suite) => ({
        kind: "suite" as const,
        ...suite,
      })),
      ...topLevelHooks.map((hook) => ({
        kind: "hook" as const,
        ...hook,
      })),
    ].sort((left, right) => left.from - right.from);
    for (const candidate of candidates) {
      if (candidate.from < setupRange.to) continue;
      if (!isSourceTrivia(file.content.slice(setupRange.to, candidate.from))) {
        break;
      }
      setupRange.to = candidate.to;
      if (candidate.kind === "setup") foldedSetup.add(candidate.from);
      if (candidate.kind === "suite") break;
    }
    units.push(
      makeUnit(
        file,
        language,
        "module",
        "Test setup",
        setupRange,
        [],
        1,
        `<test-setup:imports:${index}>`,
      ),
    );
  }
  for (const node of setup) {
    if (foldedSetup.has(node.from)) continue;
    const firstLine = textOf(file.content, node).trim().split("\n", 1)[0] ?? "";
    const name =
      firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
    units.push(
      makeUnit(
        file,
        language,
        "module",
        name || "Test setup",
        node,
        references(file.content, node, "").map(
          (dependency) => `${file.path}:${dependency}`,
        ),
        1,
        `<test-setup:${node.name}:${name}>`,
      ),
    );
  }
  return units;
}

/** Analyzes JavaScript or TypeScript source into review units. */
export function javascriptAdapter(
  language: "javascript" | "typescript",
  extensions: readonly string[],
): LanguageAdapter {
  return {
    language,
    extensions,
    isContextOnly: (source) => isImportOnlySource(source, language),
    analyze(file) {
      const jsx = /\.(?:jsx|tsx)$/i.test(file.path);
      const parser =
        language === "typescript"
          ? javascriptParser.configure({ dialect: jsx ? "ts jsx" : "ts" })
          : javascriptParser.configure({ dialect: jsx ? "jsx" : "" });
      const tree = parser.parse(file.content);
      const nodes = descendants(
        tree,
        new Set([
          "FunctionDeclaration",
          "ClassDeclaration",
          "InterfaceDeclaration",
          "TypeAliasDeclaration",
          "EnumDeclaration",
          "NamespaceDeclaration",
          "MethodDeclaration",
          "VariableDeclaration",
        ]),
      ).filter(isModuleLevelVariable);
      const declarationUnits = nodes.map((node) => {
        const name = identifier(file.content, node);
        const declarationNode = javascriptDeclarationNode(file.content, node);
        const source = textOf(file.content, declarationNode);
        const variableInitializerIsFunction =
          node.name === "VariableDeclaration" &&
          directChildren(node, new Set(["ArrowFunction", "FunctionExpression"]))
            .length > 0;
        const kind: UnitKind = [
          "ClassDeclaration",
          "InterfaceDeclaration",
          "TypeAliasDeclaration",
          "EnumDeclaration",
          "NamespaceDeclaration",
        ].includes(node.name)
          ? "class"
          : node.name === "MethodDeclaration"
            ? "method"
            : node.name === "VariableDeclaration" &&
                !variableInitializerIsFunction
              ? /\bconst\b/.test(source)
                ? "constant"
                : "variable"
              : "function";
        const complexity =
          1 +
          (source.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g)?.length ??
            0);
        return makeUnit(
          file,
          language,
          kind,
          name,
          declarationNode,
          references(file.content, node, name).map(
            (dependency) => `${file.path}:${dependency}`,
          ),
          complexity,
          qualifiedName(file.content, node, name),
        );
      });
      const nestedLogicUnits = javascriptNestedLogicUnits(
        file,
        language,
        nodes,
      );
      const tests = javascriptTestUnits(file, language, tree);
      const testSetupUnits = tests.units.length
        ? javascriptTestSetupUnits(file, language, tree, tests.detected)
        : [];
      const standaloneTestUnits = tests.units.filter(
        (unit) =>
          unit.kind !== "test_hook" ||
          !testSetupUnits.some(
            (setup) =>
              setup.name === "Test setup" &&
              setup.startLine <= unit.startLine &&
              setup.endLine >= unit.endLine,
          ),
      );
      return [
        ...declarationUnits,
        ...nestedLogicUnits,
        ...testSetupUnits,
        ...standaloneTestUnits,
      ];
    },
  };
}
