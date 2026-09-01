import type { Node as SyntaxNode } from "web-tree-sitter";
import { stableReviewKey } from "../../hash";
import { nodeText, syntaxDescendants } from "../../tree-sitter";
import type { RawUnit, SourceFile, UnitKind } from "../../types";
import type { CandidateToolkit } from "../tree-sitter-candidate-types";
import { shapes } from "../tree-sitter-language-shapes";

/**
 * Creates candidate strategies for languages whose review units are organized
 * around executable scripts and command-oriented declarations.
 */
export function createScriptingCandidateStrategies(toolkit: CandidateToolkit) {
  const {
    callRole,
    complexity,
    leadingDocumentationStart,
    makeRawRangeUnit,
    syntaxAncestors,
  } = toolkit;

  /**
   * Returns the assignment that carries a Lua declaration's targets and values.
   * A `local` binding wraps its assignment in `variable_declaration`, while a
   * global binding is the assignment itself; a value-less `local x` has no
   * assignment at all and keeps its target list directly.
   */
  function luaAssignment(node: SyntaxNode) {
    if (node.type !== "variable_declaration") return node;
    return (
      node.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && child.type === "assignment_statement",
      ) ?? node
    );
  }

  /** Extracts the assigned variable path from a Lua declaration. */
  function luaVariableName(source: string, node: SyntaxNode) {
    const list = luaAssignment(node).namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "variable_list",
    );
    const target = list?.namedChildren.find(
      (child): child is SyntaxNode => child !== null,
    );
    return target ? nodeText(source, target) : undefined;
  }

  /** Returns the semantic targets declared by a Make rule. */
  function makeRuleTargets(source: string, node: SyntaxNode) {
    const targets = node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "targets",
    );
    return (
      targets?.namedChildren
        .filter((child): child is SyntaxNode => child !== null)
        .map(
          (child) => nodeText(source, child).split("\n").at(-1)?.trim() ?? "",
        )
        .filter(Boolean) ?? []
    );
  }

  /** Recovers the true Make rule start after a grammar recovery node. */
  function makeRuleStart(source: string, node: SyntaxNode) {
    const targets = node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "targets",
    );
    return targets && nodeText(source, targets).includes("\n")
      ? source.lastIndexOf("\n", targets.endIndex - 1) + 1
      : node.startIndex;
  }

  /** Returns the method name invoked by a Ruby call. */
  function rubyCallName(source: string, node: SyntaxNode) {
    const method = node.childForFieldName("method");
    return method ? nodeText(source, method) : undefined;
  }

  /** Returns the executable name of a shell command node. */
  function shellCommandName(source: string, node: SyntaxNode) {
    const commandName = node.childForFieldName("name");
    return commandName ? nodeText(source, commandName) : undefined;
  }

  /** Returns the sourced path for a plain shell source command. */
  function shellSourceSpecifier(source: string, node: SyntaxNode) {
    if (
      node.type !== "command" ||
      ![".", "source"].includes(shellCommandName(source, node) ?? "")
    ) {
      return undefined;
    }
    const argument = node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null &&
        child !== node.childForFieldName("name") &&
        ["concatenation", "string", "word"].includes(child.type),
    );
    return argument
      ? nodeText(source, argument).replace(/^["']|["']$/g, "")
      : undefined;
  }

  /** Includes contiguous shell documentation comments before a node. */
  function shellDocumentationStart(source: string, node: SyntaxNode) {
    const syntaxStart = leadingDocumentationStart(
      source,
      node,
      shapes.shell,
      "shell",
    );
    if (syntaxStart < node.startIndex) return syntaxStart;
    let start = node.startIndex;
    let cursor = source.lastIndexOf("\n", node.startIndex - 1) + 1;
    while (cursor > 0) {
      const previousEnd = cursor - 1;
      const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
      const line = source.slice(previousStart, previousEnd);
      if (!/^\s*#(?!!)/.test(line)) break;
      start = previousStart;
      cursor = previousStart;
    }
    return start;
  }

  /** Extracts cohesive shell setup, functions, tests, and execution flows. */
  function shellReviewCandidates(
    file: SourceFile,
    root: SyntaxNode,
  ): Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }> {
    const source = file.content;
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    /** Adds a shell candidate with an explicit semantic range. */
    const add = (
      node: SyntaxNode,
      kind: UnitKind,
      name: string,
      ownName: string,
      start = shellDocumentationStart(source, node),
      end = node.endIndex,
    ) => {
      const unit = makeRawRangeUnit(file, "shell", kind, name, start, end);
      unit.complexity = complexity(node);
      candidates.push({ node, ownName, unit });
    };
    const testFile =
      file.path.endsWith(".bats") ||
      /(?:^|[/_.-])tests?(?:[/_.-]|$)/i.test(file.path);
    const topLevel = root.namedChildren.filter(
      (node): node is SyntaxNode => node !== null,
    );
    const functions = topLevel.filter(
      (node) => node.type === "function_definition",
    );

    for (const node of functions) {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;
      const name = nodeText(source, nameNode);
      const normalized = name.toLowerCase();
      const kind: UnitKind = testFile
        ? ["setup", "setup_file", "teardown", "teardown_file"].includes(
            normalized,
          ) ||
          name === "setUp" ||
          name === "tearDown"
          ? "test_hook"
          : name.startsWith("test")
            ? "test"
            : "function"
        : "function";
      add(node, kind, name, name);
    }

    const batsCommands = new Set<SyntaxNode>();
    if (file.path.endsWith(".bats")) {
      for (const [index, node] of topLevel.entries()) {
        if (
          node.type !== "command" ||
          shellCommandName(source, node) !== "@test"
        ) {
          continue;
        }
        batsCommands.add(node);
        const labelNode = syntaxDescendants(node).find(
          (child) => child.type === "string" || child.type === "raw_string",
        );
        const label = labelNode
          ? nodeText(source, labelNode).replace(/^["']|["']$/g, "")
          : `Bats test ${index + 1}`;
        let end = node.endIndex;
        for (
          let bodyIndex = index + 1;
          bodyIndex < topLevel.length;
          bodyIndex += 1
        ) {
          const bodyNode = topLevel[bodyIndex];
          if (!bodyNode) continue;
          batsCommands.add(bodyNode);
          if (
            bodyNode.type === "command" &&
            shellCommandName(source, bodyNode) === "}"
          ) {
            end = bodyNode.endIndex;
            break;
          }
        }
        add(node, "test", label, label, node.startIndex, end);
      }
    }

    const meaningful = topLevel.filter(
      (node) =>
        node.type !== "comment" &&
        node.type !== "function_definition" &&
        !batsCommands.has(node) &&
        shellSourceSpecifier(source, node) === undefined,
    );
    const firstFunction = functions[0];
    const lastFunction = functions.at(-1);
    const phases = new Map<
      "Script execution" | "Script flow" | "Script setup",
      SyntaxNode[]
    >();
    for (const node of meaningful) {
      const phase =
        !firstFunction || !lastFunction
          ? "Script flow"
          : node.endIndex <= firstFunction.startIndex
            ? "Script setup"
            : node.startIndex >= lastFunction.endIndex
              ? "Script execution"
              : "Script flow";
      const nodes = phases.get(phase) ?? [];
      nodes.push(node);
      phases.set(phase, nodes);
    }
    for (const [name, nodes] of phases) {
      const first = nodes[0];
      const last = nodes.at(-1);
      if (!first || !last) continue;
      add(
        first,
        "module",
        name,
        name,
        shellDocumentationStart(source, first),
        last.endIndex,
      );
    }
    return candidates.sort(
      (left, right) => left.unit.startLine - right.unit.startLine,
    );
  }

  /** Returns the direct argument nodes of a Ruby call. */
  function rubyArgumentNodes(node: SyntaxNode) {
    const argumentsNode = node.childForFieldName("arguments");
    return (
      argumentsNode?.namedChildren.filter(
        (child): child is SyntaxNode => child !== null,
      ) ?? []
    );
  }

  /** Extracts the display label carried by a Ruby DSL call. */
  function rubyArgumentLabel(source: string, node: SyntaxNode) {
    const argument = rubyArgumentNodes(node)[0];
    if (!argument) return undefined;
    return nodeText(source, argument)
      .replace(/^["':]+|["']+$/g, "")
      .trim();
  }

  /** Returns the first implementation offset of a Ruby declaration or block. */
  function rubyBodyStart(node: SyntaxNode) {
    const block =
      node.childForFieldName("block") ??
      node.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && ["block", "do_block"].includes(child.type),
      );
    const body = block
      ? syntaxDescendants(block).find((child) =>
          ["block_body", "body_statement"].includes(child.type),
        )
      : node.childForFieldName("body");
    return body?.startIndex ?? node.endIndex;
  }

  /** Computes the namespace, singleton state, and test role of a Ruby node. */
  function rubyScope(
    source: string,
    node: SyntaxNode,
  ): { name: string; singleton: boolean; testSuite: boolean } {
    const parts: string[] = [];
    let singleton = false;
    let testSuite = false;
    for (const parent of syntaxAncestors(node).reverse()) {
      if (parent.type === "module" || parent.type === "class") {
        const nameNode = parent.childForFieldName("name");
        if (nameNode) parts.push(nodeText(source, nameNode));
        if (parent.type === "class") {
          const superclass = parent.childForFieldName("superclass");
          const className = nameNode ? nodeText(source, nameNode) : "";
          testSuite ||= Boolean(
            (superclass &&
              /(?:Minitest::Test|Test::Unit::Test)/.test(
                nodeText(source, superclass),
              )) ||
              /Test$/.test(className),
          );
        }
      } else if (
        parent.type === "call" &&
        rubyCallName(source, parent) === "refine"
      ) {
        parts.push(
          `Refinement(${rubyArgumentLabel(source, parent) ?? "Object"})`,
        );
      } else if (parent.type === "singleton_class") {
        singleton = true;
      }
    }
    return { name: parts.join("::"), singleton, testSuite };
  }

  /** Includes contiguous Ruby documentation comments before a node. */
  function rubyDocumentationStart(source: string, node: SyntaxNode) {
    const syntaxStart = leadingDocumentationStart(
      source,
      node,
      shapes.ruby,
      "ruby",
    );
    if (syntaxStart < node.startIndex) return syntaxStart;
    let start = node.startIndex;
    let cursor = source.lastIndexOf("\n", node.startIndex - 1) + 1;
    while (cursor > 0) {
      const previousEnd = cursor - 1;
      const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
      if (!/^\s*#/.test(source.slice(previousStart, previousEnd))) break;
      start = previousStart;
      cursor = previousStart;
    }
    return start;
  }

  /** Converts a Ruby documentation comment into a setup-unit label. */
  function rubyCommentLabel(source: string, node: SyntaxNode) {
    const start = rubyDocumentationStart(source, node);
    if (start === node.startIndex) return undefined;
    const comments = source
      .slice(start, node.startIndex)
      .split("\n")
      .map((line) => line.trim().replace(/^#+\s?/, ""))
      .filter(Boolean);
    return comments.at(-1);
  }

  /** Extracts Ruby declarations, DSL constructs, tests, and setup flows. */
  function rubyReviewCandidates(
    file: SourceFile,
    root: SyntaxNode,
  ): Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }> {
    const source = file.content;
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    /** Adds a Ruby candidate with an explicit semantic range. */
    /**
     * Extends a statement over the heredoc text it opened.
     *
     * Ruby places a heredoc's body after the statement that introduces it rather
     * than inside it, so a constant assigned one ended at the `<<~SQL` and left
     * its own text behind as a range belonging to nothing.
     */
    const throughHeredocBody = (node: SyntaxNode) => {
      let end = node.endIndex;
      for (
        let sibling = node.nextNamedSibling;
        sibling?.type === "heredoc_body" &&
        source.slice(end, sibling.startIndex).trim() === "";
        sibling = sibling.nextNamedSibling
      ) {
        end = sibling.endIndex;
      }
      return end;
    };
    /** Records one Ruby declaration, documentation and heredoc text included. */
    const add = (
      node: SyntaxNode,
      kind: UnitKind,
      name: string,
      ownName: string,
      start = rubyDocumentationStart(source, node),
      end = throughHeredocBody(node),
    ) => {
      const unit = makeRawRangeUnit(file, "ruby", kind, name, start, end);
      unit.complexity = complexity(node);
      candidates.push({ node, ownName, unit });
    };
    const contextCalls = new Set([
      "autoload",
      "load",
      "require",
      "require_relative",
    ]);
    const suiteCalls = new Set(["context", "describe", "shared_examples"]);
    const hookCalls = new Set(["after", "around", "before", "let", "subject"]);
    const exampleCalls = new Set(["it", "specify"]);

    for (const node of syntaxDescendants(root)) {
      if (node.type !== "class" && node.type !== "module") continue;
      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;
      const name = nodeText(source, nameNode);
      const superclass = node.childForFieldName("superclass");
      const testSuite =
        node.type === "class" &&
        ((superclass &&
          /(?:Minitest::Test|Test::Unit::Test)/.test(
            nodeText(source, superclass),
          )) ||
          (/Test$/.test(name) && file.path.toLowerCase().includes("test")));
      add(
        node,
        testSuite ? "test_suite" : node.type === "module" ? "module" : "class",
        name,
        name,
        rubyDocumentationStart(source, node),
        rubyBodyStart(node),
      );
    }

    for (const node of syntaxDescendants(root)) {
      if (node.type !== "assignment") continue;
      if (
        syntaxAncestors(node).some(
          (parent) =>
            parent.type === "method" ||
            parent.type === "do_block" ||
            parent.type === "block",
        )
      ) {
        continue;
      }
      const left = node.childForFieldName("left");
      if (!left) continue;
      const rawName = nodeText(source, left);
      if (
        !["constant", "instance_variable", "class_variable"].includes(left.type)
      ) {
        continue;
      }
      const scope = rubyScope(source, node).name;
      const name = scope ? `${scope}::${rawName}` : rawName;
      add(
        node,
        left.type === "constant" ? "constant" : "variable",
        name,
        rawName,
      );
    }

    for (const node of syntaxDescendants(root)) {
      if (node.type !== "method" && node.type !== "singleton_method") continue;
      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;
      const methodName = nodeText(source, nameNode);
      const scope = rubyScope(source, node);
      // `def self.call` declares on the singleton the same way a `class << self`
      // body does, so both address the method through the class rather than one
      // of its instances.
      const singleton = scope.singleton || node.type === "singleton_method";
      const name = scope.testSuite
        ? `${scope.name.split("::").at(-1)} › ${methodName}`
        : `${scope.name}${singleton ? "." : "#"}${methodName}`;
      const kind: UnitKind = scope.testSuite
        ? methodName === "setup" || methodName === "teardown"
          ? "test_hook"
          : methodName.startsWith("test_")
            ? "test"
            : "method"
        : "method";
      add(node, kind, name, methodName);
    }

    for (const node of syntaxDescendants(root)) {
      if (node.type === "alias") {
        const scope = rubyScope(source, node).name;
        const aliasName = node.childForFieldName("name");
        if (scope && aliasName) {
          const name = nodeText(source, aliasName);
          add(node, "method", `${scope}#alias ${name}`, name);
        }
        continue;
      }
      if (node.type !== "call") continue;
      const method = rubyCallName(source, node);
      if (!method) continue;
      const scope = rubyScope(source, node);
      const argumentsNodes = rubyArgumentNodes(node);
      const symbolLabels = argumentsNodes
        .filter((argument) =>
          ["simple_symbol", "string"].includes(argument.type),
        )
        .map((argument) =>
          nodeText(source, argument).replace(/^["':]+|["']+$/g, ""),
        );

      if (method === "refine") {
        const target = rubyArgumentLabel(source, node) ?? "Object";
        add(
          node,
          "class",
          `Refinement(${target})`,
          `Refinement(${target})`,
          rubyDocumentationStart(source, node),
          rubyBodyStart(node),
        );
        continue;
      }
      if (
        method === "attr_reader" ||
        method === "attr_writer" ||
        method === "attr_accessor"
      ) {
        if (scope.name) {
          add(
            node,
            "method",
            `${scope.name}#attributes ${symbolLabels.join(", ")}`,
            symbolLabels.join(","),
          );
        }
        continue;
      }
      if (method === "define_method" || method === "define_singleton_method") {
        const defined = symbolLabels[0];
        if (scope.name && defined) {
          add(node, "method", `${scope.name}#${defined}`, defined);
        }
        continue;
      }
      if (method === "alias_method") {
        const defined = symbolLabels[0];
        if (scope.name && defined) {
          add(node, "method", `${scope.name}#alias ${defined}`, defined);
        }
        continue;
      }
      if (method === "delegate" || method === "def_delegators") {
        const delegated =
          method === "def_delegators"
            ? symbolLabels.slice(1)
            : symbolLabels.filter(
                (_, index) => argumentsNodes[index]?.type !== "pair",
              );
        if (scope.name && delegated.length > 0) {
          add(
            node,
            "method",
            `${scope.name}#delegates ${delegated.join(", ")}`,
            delegated.join(","),
          );
        }
        continue;
      }

      const isRSpecCall =
        suiteCalls.has(method) ||
        hookCalls.has(method) ||
        exampleCalls.has(method) ||
        (method === "test" && scope.testSuite);
      if (isRSpecCall) {
        const parents = syntaxAncestors(node)
          .filter(
            (parent) =>
              parent.type === "call" &&
              suiteCalls.has(rubyCallName(source, parent) ?? ""),
          )
          .reverse()
          .map(
            (parent) =>
              rubyArgumentLabel(source, parent) ??
              rubyCallName(source, parent) ??
              "suite",
          );
        const ownLabel =
          suiteCalls.has(method) ||
          exampleCalls.has(method) ||
          method === "test"
            ? (rubyArgumentLabel(source, node) ?? method)
            : method;
        const classSuite =
          scope.testSuite && parents.length === 0
            ? scope.name.split("::").at(-1)
            : undefined;
        const name = [...(classSuite ? [classSuite] : parents), ownLabel].join(
          " › ",
        );
        add(
          node,
          suiteCalls.has(method)
            ? "test_suite"
            : hookCalls.has(method)
              ? "test_hook"
              : "test",
          name,
          ownLabel,
          rubyDocumentationStart(source, node),
          suiteCalls.has(method) ? rubyBodyStart(node) : node.endIndex,
        );
      }
    }

    for (const container of syntaxDescendants(root).filter(
      (node) => node.type === "class",
    )) {
      const nameNode = container.childForFieldName("name");
      const body = container.childForFieldName("body");
      if (!nameNode || !body) continue;
      const className = nodeText(source, nameNode);
      const statements = body.namedChildren.filter(
        (child): child is SyntaxNode =>
          child !== null && child.type !== "comment",
      );
      const setup = statements.filter(
        (statement) =>
          statement.type === "call" &&
          ["extend", "include", "prepend"].includes(
            rubyCallName(source, statement) ?? "",
          ),
      );
      if (setup.length > 0) {
        add(
          setup[0] as SyntaxNode,
          "module",
          `${className} class setup`,
          `${className}.setup`,
          (setup[0] as SyntaxNode).startIndex,
          (setup.at(-1) as SyntaxNode).endIndex,
        );
      }
      const grouped = statements.filter(
        (statement) =>
          statement.type === "call" &&
          ![
            "alias_method",
            "attr_accessor",
            "attr_reader",
            "attr_writer",
            "define_method",
            "define_singleton_method",
            "delegate",
            "def_delegators",
            "extend",
            "include",
            "prepend",
            "refine",
            "test",
          ].includes(rubyCallName(source, statement) ?? ""),
      );
      const first = grouped[0];
      const last = grouped.at(-1);
      if (first && last) {
        add(
          first,
          "module",
          rubyCommentLabel(source, first) ?? `${className} class behavior`,
          `${className}.behavior`,
          rubyDocumentationStart(source, first),
          last.endIndex,
        );
      }
      for (const statement of statements.filter(
        (candidate) =>
          candidate.type === "identifier" &&
          ["private", "protected", "public"].includes(
            nodeText(source, candidate),
          ),
      )) {
        const visibility = nodeText(source, statement);
        add(
          statement,
          "module",
          `${className} visibility: ${visibility}`,
          `${className}.${visibility}`,
        );
      }
    }

    for (const node of root.namedChildren) {
      if (node?.type !== "call") continue;
      const method = rubyCallName(source, node);
      const receiver = node.childForFieldName("receiver");
      if (
        !method ||
        (!receiver && contextCalls.has(method)) ||
        suiteCalls.has(method)
      ) {
        continue;
      }
      add(
        node,
        "module",
        rubyCommentLabel(source, node) ?? "Ruby setup",
        `setup@${node.startIndex}`,
      );
    }
    return candidates;
  }

  /** Returns named and anonymous syntax nodes in breadth-first order. */
  function allSyntaxNodes(root: SyntaxNode) {
    const nodes: SyntaxNode[] = [root];
    for (let index = 0; index < nodes.length; index += 1) {
      for (const child of nodes[index]?.children ?? []) {
        if (child) nodes.push(child);
      }
    }
    return nodes;
  }

  /** Extracts target-like words from Make prerequisite syntax. */
  function makePrerequisiteWords(source: string, node: SyntaxNode) {
    return syntaxDescendants(node)
      .filter(
        (child) =>
          child.type === "word" &&
          child.parent !== null &&
          ["prerequisites", "pattern_list"].includes(child.parent.type),
      )
      .map((child) => nodeText(source, child));
  }

  /** Returns the operator token used by a Make variable assignment. */
  function makeAssignmentOperator(source: string, node: SyntaxNode) {
    return node.children
      .filter((child): child is SyntaxNode => child !== null)
      .map((child) => nodeText(source, child))
      .find((token) => ["!=", "+=", "::=", ":=", "?=", "="].includes(token));
  }

  /** Extracts Make variables, canned recipes, rules, and configuration units. */
  function makeReviewCandidates(
    file: SourceFile,
    root: SyntaxNode,
  ): Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }> {
    const source = file.content;
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    const occurrences = new Map<string, number>();
    const recipePrefixNode = root.namedChildren.find(
      (node): node is SyntaxNode =>
        node !== null && node.type === "RECIPEPREFIX_assignment",
    );
    const recipePrefixValue = recipePrefixNode?.childForFieldName("value");
    const recipePrefix = recipePrefixValue
      ? nodeText(source, recipePrefixValue).trim()
      : undefined;
    /** Extends a rule through lines using a custom recipe prefix. */
    const extendedRecipeEnd = (start: number, initialEnd: number) => {
      if (!recipePrefix) return initialEnd;
      let end = initialEnd;
      let cursor =
        source[end] === "\n"
          ? end + 1
          : source.indexOf("\n", end) >= 0
            ? source.indexOf("\n", end) + 1
            : source.length;
      while (
        cursor < source.length &&
        source.slice(cursor).startsWith(recipePrefix)
      ) {
        const lineEnd = source.indexOf("\n", cursor);
        end = lineEnd < 0 ? source.length : lineEnd;
        cursor = lineEnd < 0 ? source.length : lineEnd + 1;
      }
      return Math.max(start, end);
    };
    /** Adds a Make candidate and disambiguates repeated rule identities. */
    const add = (
      node: SyntaxNode,
      kind: UnitKind,
      name: string,
      ownName: string,
      start = leadingDocumentationStart(
        source,
        node,
        shapes.makefile,
        "makefile",
      ),
      end = node.endIndex,
    ) => {
      const occurrenceKey = `${kind}:${ownName}`;
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const stableName =
        occurrence === 1 ? ownName : `${ownName}#${occurrence}`;
      const unit = makeRawRangeUnit(file, "makefile", kind, name, start, end);
      unit.stableKey = stableReviewKey(file.path, kind, stableName);
      unit.complexity = complexity(node);
      candidates.push({ node, ownName, unit });
    };

    const allRules = syntaxDescendants(root).filter(
      (node) => node.type === "rule",
    );
    const visualRules = allRules.filter((rule) => {
      const targets = rule.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && child.type === "targets",
      );
      return (
        targets !== undefined &&
        /^-{5,}.*-{5,}$/.test(nodeText(source, targets))
      );
    });
    const firstVisual = visualRules[0];
    if (firstVisual) {
      const configurationNodes = root.namedChildren.filter(
        (node): node is SyntaxNode =>
          node !== null &&
          node.startIndex < firstVisual.startIndex &&
          !shapes.makefile.comments.has(node.type),
      );
      const first = configurationNodes[0];
      const last = configurationNodes.at(-1);
      if (first && last) {
        add(
          first,
          "module",
          "Build configuration",
          "Build configuration",
          leadingDocumentationStart(source, first, shapes.makefile, "makefile"),
          last.endIndex,
        );
      }
    }

    const configurationEnd = firstVisual?.startIndex ?? -1;
    for (const node of syntaxDescendants(root)) {
      if (node.type !== "variable_assignment") continue;
      if (configurationEnd >= 0 && node.startIndex < configurationEnd) continue;
      if (
        syntaxAncestors(node).some(
          (parent) =>
            parent.type === "define_directive" || parent.type === "raw_text",
        )
      ) {
        continue;
      }
      const wrapper = syntaxAncestors(node).find((parent) =>
        ["export_directive", "override_directive"].includes(parent.type),
      );
      const declaration = wrapper ?? node;
      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;
      const name = nodeText(source, nameNode);
      const target = node.childForFieldName("target_or_pattern");
      const scope = target
        ? syntaxDescendants(target)
            .filter((child) => child.type === "word")
            .map((child) => nodeText(source, child))
            .join(" + ")
        : undefined;
      const operator = makeAssignmentOperator(source, node);
      const flavor =
        operator === ":=" || operator === "::="
          ? "simple"
          : operator === "?="
            ? "conditional"
            : operator === "+="
              ? "append"
              : "recursive";
      const decorator =
        wrapper?.type === "override_directive"
          ? "override "
          : wrapper?.type === "export_directive"
            ? "export "
            : "";
      const suffix =
        operator === "=" && !decorator ? "" : ` · ${decorator}${flavor}`;
      const displayName = `${scope ? `${scope}: ` : ""}${name}${suffix}`;
      add(declaration, "constant", displayName, name);
    }

    for (const node of syntaxDescendants(root)) {
      if (node.type !== "define_directive") continue;
      if (
        syntaxAncestors(node).some(
          (parent) =>
            parent.type === "define_directive" || parent.type === "raw_text",
        )
      ) {
        continue;
      }
      const wrapper = syntaxAncestors(node).find(
        (parent) => parent.type === "override_directive",
      );
      const declaration = wrapper ?? node;
      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;
      const name = nodeText(source, nameNode);
      let end = declaration.endIndex;
      if (!wrapper) {
        let sibling = node.nextNamedSibling;
        while (sibling && sibling.type !== "define_directive") {
          if (
            sibling.type === "ERROR" &&
            nodeText(source, sibling).trim() === "endef"
          ) {
            end = sibling.endIndex;
            break;
          }
          if (sibling.type === "rule") {
            const recoveredEnd = source
              .slice(0, makeRuleStart(source, sibling))
              .trimEnd().length;
            if (recoveredEnd > end) end = recoveredEnd;
            break;
          }
          end = sibling.endIndex;
          sibling = sibling.nextNamedSibling;
        }
      }
      add(
        declaration,
        "function",
        `${name} (canned recipe)`,
        name,
        leadingDocumentationStart(
          source,
          declaration,
          shapes.makefile,
          "makefile",
        ),
        end,
      );
    }

    if (!firstVisual) {
      for (const conditional of syntaxDescendants(root).filter(
        (node) => node.type === "conditional",
      )) {
        if (
          syntaxAncestors(conditional).some(
            (parent) => parent.type === "conditional",
          )
        ) {
          continue;
        }
        const directive = conditional.namedChildren.find(
          (child): child is SyntaxNode =>
            Boolean(child?.type.endsWith("_directive")),
        );
        if (!directive) continue;
        add(
          conditional,
          "module",
          `Conditional: ${nodeText(source, directive).trimEnd()}`,
          `conditional@${conditional.startIndex}`,
          leadingDocumentationStart(
            source,
            conditional,
            shapes.makefile,
            "makefile",
          ),
          directive.endIndex,
        );
      }
    }

    let pendingStart: number | undefined;
    let pendingPhonyTarget: string | undefined;
    for (const rule of allRules) {
      if (configurationEnd >= 0 && rule.startIndex < configurationEnd) continue;
      const targets = makeRuleTargets(source, rule);
      if (targets.length === 0) continue;
      const [firstTarget] = targets;
      const targetNode = rule.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && child.type === "targets",
      );
      if (targetNode && /^-{5,}.*-{5,}$/.test(nodeText(source, targetNode))) {
        pendingStart = rule.startIndex;
        continue;
      }
      const recoveredRuleStart = makeRuleStart(source, rule);
      const ruleLineStart =
        source.lastIndexOf("\n", recoveredRuleStart - 1) + 1;
      if (
        recipePrefix &&
        source.slice(ruleLineStart, rule.startIndex).startsWith(recipePrefix)
      ) {
        continue;
      }
      if (firstTarget === ".PHONY") {
        const phonyTargets = makePrerequisiteWords(source, rule);
        if (firstVisual && phonyTargets.length === 1) {
          pendingStart ??= rule.startIndex;
          pendingPhonyTarget = phonyTargets[0];
        } else {
          add(rule, "module", "Phony targets", ".PHONY");
        }
        continue;
      }
      const grouped =
        targets.length > 1 &&
        source
          .slice(
            rule.startIndex,
            rule.namedChildren.find(
              (child) => child !== null && child.type === "recipe",
            )?.startIndex ?? rule.endIndex,
          )
          .includes("&:");
      const name =
        targets.length === 1
          ? (targets[0] as string)
          : targets.join(grouped ? " & " : " + ");
      const lower = name.toLowerCase();
      const kind: UnitKind =
        lower === "setup" || lower === "bootstrap"
          ? "test_hook"
          : ["check", "lint", "test", "tests"].includes(lower)
            ? "test"
            : firstTarget === ".DELETE_ON_ERROR"
              ? "module"
              : "function";
      const start =
        pendingStart !== undefined &&
        (!pendingPhonyTarget || pendingPhonyTarget === firstTarget)
          ? pendingStart
          : recoveredRuleStart === rule.startIndex
            ? leadingDocumentationStart(
                source,
                rule,
                shapes.makefile,
                "makefile",
              )
            : recoveredRuleStart;
      add(
        rule,
        kind,
        name,
        name,
        start,
        extendedRecipeEnd(recoveredRuleStart, rule.endIndex),
      );
      pendingStart = undefined;
      pendingPhonyTarget = undefined;
    }

    if (recipePrefix) {
      for (const token of allSyntaxNodes(root).filter(
        (node) => node.type === ":",
      )) {
        const lineStart = source.lastIndexOf("\n", token.startIndex - 1) + 1;
        if (source.slice(lineStart, token.startIndex).includes(recipePrefix)) {
          continue;
        }
        const header = source.slice(lineStart, token.startIndex).trim();
        if (!header || candidates.some(({ unit }) => unit.name === header)) {
          continue;
        }
        const lineEnd = source.indexOf("\n", token.endIndex);
        const declarationEnd = lineEnd < 0 ? source.length : lineEnd;
        add(
          token.parent ?? token,
          "function",
          header,
          header,
          lineStart,
          extendedRecipeEnd(lineStart, declarationEnd),
        );
      }
    }
    return candidates;
  }

  /** Returns the first value assigned by a Lua declaration. */
  function luaValueNode(node: SyntaxNode) {
    const values = luaAssignment(node).namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "expression_list",
    );
    return values?.namedChildren.find(
      (child): child is SyntaxNode => child !== null,
    );
  }

  /** Extracts the module specifier bound or executed by a Lua require call. */
  function luaRequireSpec(source: string, node: SyntaxNode) {
    const call =
      node.type === "function_call"
        ? node
        : syntaxDescendants(node).find(
            (child) => child.type === "function_call",
          );
    if (!call) return undefined;
    const callee = call.childForFieldName("name");
    if (!callee || nodeText(source, callee) !== "require") return undefined;
    const specifier = syntaxDescendants(call).find(
      (child) => child.type === "string_content",
    );
    return specifier ? nodeText(source, specifier) : undefined;
  }

  /** Returns the name a Lua statement reads or returns, such as `return M`. */
  function luaReferencedName(source: string, node: SyntaxNode) {
    const reference = syntaxDescendants(node).find((child) =>
      shapes.lua.identifierTypes.has(child.type),
    );
    return reference ? nodeText(source, reference) : undefined;
  }

  /** Extracts Lua declarations, modules, classes, and test DSL constructs. */
  function luaReviewCandidates(
    file: SourceFile,
    root: SyntaxNode,
  ): Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }> {
    const source = file.content;
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    const returnStatements = root.namedChildren.filter(
      (node): node is SyntaxNode =>
        node !== null && node.type === "return_statement",
    );
    const returnedModules = new Set(
      returnStatements
        .map((node) => luaReferencedName(source, node))
        .filter((name): name is string => name !== undefined),
    );
    /** Adds a Lua candidate with an explicit semantic range. */
    const add = (
      node: SyntaxNode,
      kind: UnitKind,
      name: string,
      ownName: string,
      start = leadingDocumentationStart(source, node, shapes.lua, "lua"),
      end = node.endIndex,
    ) => {
      const unit = makeRawRangeUnit(file, "lua", kind, name, start, end);
      unit.complexity = complexity(node);
      candidates.push({ node, ownName, unit });
    };

    for (const node of root.namedChildren) {
      if (!node) continue;
      if (shapes.lua.variables.has(node.type)) {
        const name = luaVariableName(source, node);
        const value = luaValueNode(node);
        if (!name || !value) continue;
        if (luaRequireSpec(source, node)) continue;
        if (value.type === "function_definition") {
          add(
            node,
            name.includes(".") || name.includes(":") ? "method" : "function",
            name,
            name,
          );
          continue;
        }
        if (name.includes(".") || name.includes(":")) continue;
        const documented = source.slice(
          leadingDocumentationStart(source, node, shapes.lua, "lua"),
          node.startIndex,
        );
        if (
          value.type === "table_constructor" &&
          (/@class\b/.test(documented) || /^Test[A-Z_]/.test(name))
        ) {
          add(node, "class", `Class ${name}`, name);
        } else if (!returnedModules.has(name)) {
          add(
            node,
            /^[A-Z][A-Z0-9_]*$/.test(name) || value.type === "table_constructor"
              ? "constant"
              : "variable",
            name,
            name,
          );
        }
        continue;
      }
      if (shapes.lua.functions.has(node.type)) {
        const nameNode = node.childForFieldName("name");
        const name = nameNode ? nodeText(source, nameNode) : undefined;
        if (!name) continue;
        const [owner, member] = name.split(/[.:](?=[^.:]+$)/);
        if (
          file.path.toLowerCase().includes("test") &&
          owner &&
          member &&
          /^Test/.test(owner)
        ) {
          const lower = member.toLowerCase();
          add(
            node,
            lower === "setup" || lower === "teardown"
              ? "test_hook"
              : lower.startsWith("test")
                ? "test"
                : "method",
            `${owner} › ${member}`,
            name,
          );
        } else {
          add(
            node,
            name.includes(".") || name.includes(":") ? "method" : "function",
            name,
            name,
          );
        }
      }
    }

    const calls = syntaxDescendants(root)
      .filter((node) => node.type === "function_call")
      .map((node) => {
        const role = callRole(source, node);
        return role ? { node, role } : undefined;
      })
      .filter(
        (
          call,
        ): call is {
          node: SyntaxNode;
          role: NonNullable<ReturnType<typeof callRole>>;
        } => call !== undefined,
      );
    const suites = calls.filter(({ role }) => role.kind === "test_suite");
    for (const call of calls) {
      const parents = suites
        .filter(
          (suite) =>
            suite.node.startIndex < call.node.startIndex &&
            suite.node.endIndex >= call.node.endIndex,
        )
        .sort((left, right) => left.node.startIndex - right.node.startIndex);
      const ownLabel =
        call.role.kind === "test_hook"
          ? call.role.name.replaceAll("_", " ")
          : call.role.name;
      const name = [...parents.map(({ role }) => role.name), ownLabel].join(
        " › ",
      );
      add(call.node, call.role.kind, name, name, call.node.startIndex);
    }

    for (const statement of returnStatements) {
      const name = luaReferencedName(source, statement);
      if (!name) continue;
      add(statement, "module", `Module ${name}`, name);
    }

    if (candidates.length === 0) {
      const executable = root.namedChildren.filter(
        (node): node is SyntaxNode =>
          node !== null &&
          !shapes.lua.comments.has(node.type) &&
          luaRequireSpec(source, node) === undefined,
      );
      const first = executable[0];
      const last = executable.at(-1);
      if (first && last) {
        add(
          first,
          "module",
          "Lua module statements",
          "statements",
          first.startIndex,
          last.endIndex,
        );
      }
    }
    return candidates;
  }

  /** Returns the identifier assigned by an HCL attribute. */

  return {
    probes: {
      luaRequireSpec,
      luaVariableName,
      rubyCallName,
      shellSourceSpecifier,
    },
    strategies: {
      lua: { extract: luaReviewCandidates },
      makefile: { extract: makeReviewCandidates },
      ruby: { extract: rubyReviewCandidates },
      shell: { extract: shellReviewCandidates },
    },
  };
}
