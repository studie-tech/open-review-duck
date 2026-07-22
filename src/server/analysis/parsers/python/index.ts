import type { SyntaxNode, Tree } from "@lezer/common";
import { parser as pythonParser } from "@lezer/python";
import { isImportOnlySource } from "~/lib/import-navigation";
import type {
  AnalyzedUnit,
  LanguageAdapter,
  SourceFile,
  UnitKind,
} from "../../types";
import { supportedExtensions } from "../../types";
import {
  callSegments,
  containsNode,
  descendants,
  directChildren,
  identifier,
  isSourceTrivia,
  isTestLikePath,
  lineAt,
  makeUnit,
  nodeKey,
  qualifiedName,
  references,
  type SourceRange,
  testCallLabel,
  textOf,
} from "../shared";

const pythonHookNames = new Set([
  "setup_module",
  "teardown_module",
  "setup_function",
  "teardown_function",
  "setup_class",
  "teardown_class",
  "setup_method",
  "teardown_method",
  "setUp",
  "tearDown",
  "setUpClass",
  "tearDownClass",
  "asyncSetUp",
  "asyncTearDown",
]);

/** Returns a Python declaration including any decorators applied to it. */
function pythonDeclarationNode(node: SyntaxNode) {
  return node.parent?.name === "DecoratedStatement" ? node.parent : node;
}

/** Returns the class directly containing a Python declaration. */
function pythonParentClass(node: SyntaxNode) {
  const declaration = pythonDeclarationNode(node);
  return declaration.parent?.name === "Body" &&
    declaration.parent.parent?.name === "ClassDefinition"
    ? declaration.parent.parent
    : undefined;
}

/** Returns the class header, docstring, and decorators without nested members. */
function pythonClassReviewNode(source: string, node: SyntaxNode): SourceRange {
  const declaration = pythonDeclarationNode(node);
  const body = directChildren(node, new Set(["Body"]))[0];
  if (!body) return declaration;
  const statements = directChildren(body).filter(
    (child) => child.name !== ":" && !child.name.endsWith("Comment"),
  );
  const members = statements.filter((child, index) => {
    if (
      index === 0 &&
      child.name === "ExpressionStatement" &&
      containsNode(child, new Set(["String"]))
    ) {
      return false;
    }
    return true;
  });
  if (
    members.length === 0 ||
    (members.length === 1 &&
      ["PassStatement", "ExpressionStatement"].includes(members[0]?.name ?? ""))
  ) {
    return declaration;
  }
  const firstMember = members[0];
  if (!firstMember) return declaration;
  let to = firstMember.from;
  while (to > declaration.from && /\s/.test(source[to - 1] ?? "")) to -= 1;
  return { from: declaration.from, to };
}

/** Returns the directly assigned Python identifiers in one statement. */
function pythonAssignmentNames(source: string, node: SyntaxNode) {
  const children = directChildren(node);
  let lastAssignment = -1;
  for (let index = 0; index < children.length; index += 1) {
    if (children[index]?.name === "AssignOp") lastAssignment = index;
  }
  if (lastAssignment < 0) {
    const annotated = children.find((child) => child.name === "VariableName");
    return annotated ? [textOf(source, annotated)] : [];
  }
  return children
    .slice(0, lastAssignment)
    .filter((child) => child.name === "VariableName")
    .map((child) => textOf(source, child));
}

/** Classifies a Python assignment by its review-level semantics. */
function pythonAssignmentKind(
  source: string,
  node: SyntaxNode,
  names: readonly string[],
): Extract<UnitKind, "constant" | "function" | "variable"> {
  if (containsNode(node, new Set(["LambdaExpression"]))) return "function";
  const declaration = textOf(source, node);
  if (
    names.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name)) ||
    /^[^=]*\bFinal\s*(?:\[|=|$)/.test(declaration)
  ) {
    return "constant";
  }
  return "variable";
}

/** Returns a source range spanning complete one-based source lines. */
function sourceLineRange(source: string, startLine: number, endLine: number) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  const from = starts[startLine - 1] ?? 0;
  let to = starts[endLine] ?? source.length;
  while (to > from && source[to - 1] === "\n") to -= 1;
  return { from, to };
}

/** Groups adjacent conventional Python setup/teardown methods as lifecycle units. */
function groupPythonLifecycleUnits(
  file: SourceFile,
  units: Array<Omit<AnalyzedUnit, "depth" | "reviewOrder">>,
) {
  const groups: Array<typeof units> = [];
  for (const unit of units) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const name = unit.name.split(" › ").at(-1) ?? unit.name;
    const previousName = previous?.name.split(" › ").at(-1);
    const scope = unit.name.includes(" › ")
      ? unit.name.slice(0, unit.name.lastIndexOf(" › "))
      : "";
    const previousScope = previous?.name.includes(" › ")
      ? previous.name.slice(0, previous.name.lastIndexOf(" › "))
      : "";
    const adjacent = Boolean(
      previous &&
        unit.kind === "test_hook" &&
        previous.kind === "test_hook" &&
        pythonHookNames.has(name) &&
        previousName &&
        pythonHookNames.has(previousName) &&
        scope === previousScope &&
        isSourceTrivia(
          file.content.slice(
            sourceLineRange(file.content, previous.startLine, previous.endLine)
              .to,
            sourceLineRange(file.content, unit.startLine, unit.endLine).from,
          ),
        ),
    );
    if (current && adjacent) current.push(unit);
    else groups.push([unit]);
  }
  return groups.map((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last)
      throw new Error("Python lifecycle group cannot be empty");
    if (group.length === 1) return first;
    const scope = first.name.includes(" › ")
      ? first.name.slice(0, first.name.lastIndexOf(" › "))
      : "";
    const memberNames = group.map(
      (unit) => unit.name.split(" › ").at(-1) ?? unit.name,
    );
    return makeUnit(
      file,
      "python",
      "test_hook",
      scope ? `${scope} › Test lifecycle` : "Test lifecycle",
      sourceLineRange(file.content, first.startLine, last.endLine),
      [...new Set(group.flatMap(({ dependencies }) => dependencies))],
      group.reduce((total, unit) => total + unit.complexity, 0),
      `lifecycle:${scope}:${memberNames.join("+")}`,
    );
  });
}

/** Extracts executable class-body statements not owned by another Python unit. */
function pythonClassStatementUnits(file: SourceFile, node: SyntaxNode) {
  const body = directChildren(node, new Set(["Body"]))[0];
  if (!body) return [];
  const children = directChildren(body);
  const firstContent = children.find(
    (child) => child.name !== ":" && !child.name.endsWith("Comment"),
  );
  const statements = children.filter((child) => {
    if (child.name === ":" || child.name.endsWith("Comment")) return false;
    if (
      child === firstContent &&
      child.name === "ExpressionStatement" &&
      containsNode(child, new Set(["String"]))
    ) {
      return false;
    }
    if (
      [
        "AssignStatement",
        "FunctionDefinition",
        "ClassDefinition",
        "TypeDefinition",
      ].includes(child.name)
    ) {
      return false;
    }
    if (
      child.name === "DecoratedStatement" &&
      containsNode(child, new Set(["FunctionDefinition", "ClassDefinition"]))
    ) {
      return false;
    }
    return Boolean(textOf(file.content, child).trim());
  });
  const groups: Array<{ from: number; to: number }> = [];
  for (const statement of statements) {
    const current = groups.at(-1);
    if (
      current &&
      isSourceTrivia(file.content.slice(current.to, statement.from))
    ) {
      current.to = statement.to;
    } else {
      groups.push({ from: statement.from, to: statement.to });
    }
  }
  const className = identifier(file.content, node);
  return groups.map((group, index) =>
    makeUnit(
      file,
      "python",
      "module",
      `${className} class statements`,
      group,
      references(file.content, node, className, group.to, group.from).map(
        (dependency) => `${file.path}:${dependency}`,
      ),
      1,
      `${qualifiedName(file.content, node, className)}:statements:${index}`,
    ),
  );
}

/** Returns the qualified stable name stored after a unit's path and kind. */
function unitStableName(
  unit: Pick<AnalyzedUnit, "stableKey" | "path" | "kind">,
) {
  return unit.stableKey.slice(`${unit.path}:${unit.kind}:`.length);
}

/** Makes Python class shells depend on their directly reviewable members. */
function linkPythonClassMembers(
  units: Array<Omit<AnalyzedUnit, "depth" | "reviewOrder">>,
) {
  return units.map((unit) => {
    if (unit.kind !== "class") return unit;
    const className = unitStableName(unit);
    const members = units.filter((candidate) => {
      if (candidate === unit) return false;
      const candidateName = unitStableName(candidate);
      if (candidateName.startsWith(`${className}:statements:`)) return true;
      if (!candidateName.startsWith(`${className}.`)) return false;
      return !candidateName.slice(className.length + 1).includes(".");
    });
    return {
      ...unit,
      dependencies: [
        ...new Set([
          ...unit.dependencies,
          ...members.map(({ stableKey }) => stableKey),
        ]),
      ],
    };
  });
}

/** Checks whether a Python class acts as a test-suite container. */
function isPythonTestClass(file: SourceFile, node: SyntaxNode, name: string) {
  const header = textOf(file.content, node).split("\n", 1)[0] ?? "";
  return (
    (/^Test(?:[A-Z_]|$)/.test(name) && isPythonTestModule(file)) ||
    /\b(?:unittest\.)?TestCase\b/.test(header)
  );
}

/** Checks whether Python source follows common test-module conventions. */
function isPythonTestModule(file: SourceFile) {
  return (
    isTestLikePath(file.path) ||
    /(?:^|\n)\s*(?:from\s+(?:pytest|unittest)\b|import\s+(?:pytest|unittest)\b)/.test(
      file.content,
    )
  );
}

/** Classifies Python functions that represent tests, fixtures, or hooks. */
function pythonTestKind(
  file: SourceFile,
  node: SyntaxNode,
  name: string,
): Extract<UnitKind, "test" | "test_hook"> | undefined {
  const declaration = textOf(file.content, pythonDeclarationNode(node));
  const parentClass = pythonParentClass(node);
  const parentClassName =
    parentClass?.name === "ClassDefinition"
      ? identifier(file.content, parentClass)
      : undefined;
  if (
    (/^(?:test(?:_|[A-Z])|it_|spec_)/.test(name) && isPythonTestModule(file)) ||
    /@(?:pytest\.)?mark\.(?:parametrize|parameterize)\b/.test(declaration) ||
    /@(?:scenario|pytest_bdd\.scenario)\b/.test(declaration) ||
    (parentClass &&
      parentClassName &&
      isPythonTestClass(file, parentClass, parentClassName) &&
      /^test/.test(name))
  ) {
    return "test";
  }
  if (
    (pythonHookNames.has(name) &&
      (isPythonTestModule(file) ||
        Boolean(
          parentClass &&
            parentClassName &&
            isPythonTestClass(file, parentClass, parentClassName),
        ))) ||
    /@(?:pytest\.)?fixture\b/.test(declaration) ||
    /@(?:given|when|then|pytest_bdd\.(?:given|when|then))\b/.test(declaration)
  ) {
    return "test_hook";
  }
  return undefined;
}

/** Creates Python BDD test units while retaining contexts as naming metadata. */
function pythonWithTestUnits(file: SourceFile, tree: Tree) {
  if (!isTestLikePath(file.path)) return [];
  const detected = new Map<
    string,
    { node: SyntaxNode; role: "suite" | "test"; label: string }
  >();
  for (const node of descendants(tree, new Set(["WithStatement"]))) {
    const call = directChildren(node, new Set(["CallExpression"]))[0];
    if (!call) continue;
    const callee = callSegments(file.content, call)[0];
    const role = ["describe", "description", "context"].includes(callee ?? "")
      ? "suite"
      : ["it", "test", "specify"].includes(callee ?? "")
        ? "test"
        : undefined;
    if (!role) continue;
    detected.set(nodeKey(node), {
      node,
      role,
      label:
        testCallLabel(file.content, call) ??
        `${callee} at line ${lineAt(file.content, node.from)}`,
    });
  }
  return [...detected.values()].flatMap(({ node, role, label }) => {
    const suites: string[] = [];
    let parent = node.parent;
    while (parent) {
      const suite = detected.get(nodeKey(parent));
      if (suite?.role === "suite") suites.unshift(suite.label);
      parent = parent.parent;
    }
    const name = [...suites, label].join(" › ");
    if (role === "suite") return [];
    const source = textOf(file.content, node);
    return [
      makeUnit(
        file,
        "python",
        "test",
        name,
        node,
        references(file.content, node, "").map(
          (dependency) => `${file.path}:${dependency}`,
        ),
        1 +
          (source.match(/\b(if|for|while|match|except|and|or)\b/g)?.length ??
            0),
        `test:${name}:with`,
      ),
    ];
  });
}

/** Checks whether a Python with-statement is a BDD suite or test container. */
function isPythonWithTestContainer(file: SourceFile, node: SyntaxNode) {
  if (node.name !== "WithStatement") return false;
  const call = directChildren(node, new Set(["CallExpression"]))[0];
  const callee = call ? callSegments(file.content, call)[0] : undefined;
  return [
    "describe",
    "description",
    "context",
    "it",
    "test",
    "specify",
  ].includes(callee ?? "");
}

/** Creates focused executable setup units for a Python test module. */
function pythonTestSetupUnits(file: SourceFile, tree: Tree) {
  const declarationNames = new Set([
    "AssignStatement",
    "FunctionDefinition",
    "ClassDefinition",
    "TypeDefinition",
  ]);
  const setup: SyntaxNode[] = [];
  for (const node of directChildren(tree.topNode)) {
    if (node.name.includes("Import")) continue;
    if (isPythonWithTestContainer(file, node)) continue;
    if (node.name.endsWith("Comment")) continue;
    if (
      node.name === "ExpressionStatement" &&
      containsNode(node, new Set(["String"])) &&
      setup.length === 0
    ) {
      continue;
    }
    if (
      declarationNames.has(node.name) ||
      (node.name === "DecoratedStatement" &&
        containsNode(node, declarationNames))
    ) {
      continue;
    }
    if (textOf(file.content, node).trim()) setup.push(node);
  }
  const groups: Array<{ from: number; to: number }> = [];
  for (const node of setup) {
    const current = groups.at(-1);
    if (current && isSourceTrivia(file.content.slice(current.to, node.from))) {
      current.to = node.to;
    } else {
      groups.push({ from: node.from, to: node.to });
    }
  }
  return groups.map((group, index) => {
    const firstLine =
      textOf(file.content, group).trim().split("\n", 1)[0] ?? "";
    const name =
      groups.length === 1
        ? "Test module setup"
        : firstLine.length > 60
          ? `${firstLine.slice(0, 57)}…`
          : firstLine || "Test module setup";
    return makeUnit(
      file,
      "python",
      "module",
      name,
      group,
      references(file.content, tree.topNode, "", group.to, group.from).map(
        (dependency) => `${file.path}:${dependency}`,
      ),
      1,
      `<test-module-setup:${index}:${name}>`,
    );
  });
}

export const pythonAdapter: LanguageAdapter = {
  language: "python",
  extensions: supportedExtensions.python,
  isContextOnly: (source) => isImportOnlySource(source, "python"),
  analyze(file) {
    const tree = pythonParser.parse(file.content);
    const nodes = descendants(
      tree,
      new Set(["FunctionDefinition", "ClassDefinition"]),
    );
    const assignmentNodes = descendants(tree, new Set(["AssignStatement"]));
    const classAttributeNames = new Map<number, Set<string>>();
    for (const assignment of assignmentNodes) {
      const parentClass =
        assignment.parent?.name === "Body" &&
        assignment.parent.parent?.name === "ClassDefinition"
          ? assignment.parent.parent
          : undefined;
      if (!parentClass) continue;
      const names = classAttributeNames.get(parentClass.from) ?? new Set();
      for (const name of pythonAssignmentNames(file.content, assignment)) {
        names.add(name);
      }
      classAttributeNames.set(parentClass.from, names);
    }
    const testSuiteClasses = new Set(
      nodes
        .filter(
          (node) =>
            node.name === "ClassDefinition" &&
            isPythonTestClass(file, node, identifier(file.content, node)),
        )
        .map((node) => node.from),
    );
    const functionAndClassUnits = nodes.flatMap((node) => {
      const name = identifier(file.content, node);
      if (node.name === "ClassDefinition" && testSuiteClasses.has(node.from))
        return [];
      const declarationNode =
        node.name === "ClassDefinition"
          ? pythonClassReviewNode(file.content, node)
          : pythonDeclarationNode(node);
      const source = textOf(file.content, declarationNode);
      const parentClass = pythonParentClass(node);
      const parentClassName = parentClass
        ? identifier(file.content, parentClass)
        : undefined;
      const kind: UnitKind =
        node.name === "FunctionDefinition"
          ? (pythonTestKind(file, node, name) ??
            (parentClass ? "method" : "function"))
          : "class";
      const displayName =
        (kind === "test" || kind === "test_hook") && parentClassName
          ? `${parentClassName} › ${name}`
          : name;
      const complexity =
        1 +
        (source.match(/\b(if|for|while|match|except|and|or)\b/g)?.length ?? 0);
      const dependencies = references(
        file.content,
        node,
        name,
        declarationNode.to,
      ).map((dependency) => {
        if (!parentClass || !parentClassName) {
          return `${file.path}:${dependency}`;
        }
        const explicitAttribute = /^(?:self|cls)\.([A-Za-z_]\w*)$/.exec(
          dependency,
        )?.[1];
        const attribute =
          explicitAttribute ??
          (classAttributeNames.get(parentClass.from)?.has(dependency)
            ? dependency
            : undefined);
        return attribute
          ? `${file.path}:${parentClassName}.${attribute}`
          : `${file.path}:${dependency}`;
      });
      return [
        makeUnit(
          file,
          "python",
          kind,
          displayName,
          declarationNode,
          dependencies,
          complexity,
          qualifiedName(file.content, node, name),
        ),
      ];
    });
    const assignmentUnits = assignmentNodes
      .filter(
        (node) =>
          node.parent?.name === "Script" ||
          (node.parent?.name === "Body" &&
            node.parent.parent?.name === "ClassDefinition"),
      )
      .flatMap((node) => {
        const names = pythonAssignmentNames(file.content, node);
        const name = names[0];
        if (!name) return [];
        const parentClass =
          node.parent?.name === "Body" &&
          node.parent.parent?.name === "ClassDefinition"
            ? node.parent.parent
            : undefined;
        const parentClassName = parentClass
          ? identifier(file.content, parentClass)
          : undefined;
        const kind = pythonAssignmentKind(file.content, node, names);
        return [
          makeUnit(
            file,
            "python",
            kind,
            parentClassName ? `${parentClassName}.${name}` : name,
            node,
            references(file.content, node, names).map(
              (dependency) => `${file.path}:${dependency}`,
            ),
            1,
            qualifiedName(file.content, node, name),
          ),
        ];
      });
    const typeAliasUnits = descendants(tree, new Set(["TypeDefinition"]))
      .filter(
        (node) =>
          node.parent?.name === "Script" ||
          (node.parent?.name === "Body" &&
            node.parent.parent?.name === "ClassDefinition"),
      )
      .map((node) => {
        const name = identifier(file.content, node);
        const parentClass =
          node.parent?.name === "Body" &&
          node.parent.parent?.name === "ClassDefinition"
            ? node.parent.parent
            : undefined;
        const parentClassName = parentClass
          ? identifier(file.content, parentClass)
          : undefined;
        return makeUnit(
          file,
          "python",
          "variable",
          parentClassName ? `${parentClassName}.${name}` : name,
          node,
          references(file.content, node, name).map(
            (dependency) => `${file.path}:${dependency}`,
          ),
          1,
          qualifiedName(file.content, node, name),
        );
      });
    const withTests = pythonWithTestUnits(file, tree);
    const groupedDeclarations = groupPythonLifecycleUnits(
      file,
      functionAndClassUnits,
    );
    const classStatementUnits = nodes
      .filter(
        (node) =>
          node.name === "ClassDefinition" && !testSuiteClasses.has(node.from),
      )
      .flatMap((node) => pythonClassStatementUnits(file, node));
    const hasTests = [...groupedDeclarations, ...withTests].some(
      ({ kind }) =>
        kind === "test" || kind === "test_suite" || kind === "test_hook",
    );
    const testSetupUnits = hasTests ? pythonTestSetupUnits(file, tree) : [];
    return linkPythonClassMembers([
      ...assignmentUnits,
      ...typeAliasUnits,
      ...groupedDeclarations,
      ...classStatementUnits,
      ...testSetupUnits,
      ...withTests,
    ]);
  },
};
