import type { Node as SyntaxNode } from "web-tree-sitter";
import {
  nodeText,
  syntaxDescendants,
  type TreeSitterLanguage,
} from "../../tree-sitter";
import type { RawUnit, SourceFile, UnitKind } from "../../types";
import type {
  CandidateStrategy,
  CandidateToolkit,
} from "../tree-sitter-candidate-types";
import { shapes } from "../tree-sitter-language-shapes";

/** Creates an immutable-by-convention syntax-node type set. */
const set = (...values: string[]) => new Set(values);

/**
 * Creates candidate strategies for declarative languages and declaration DSLs.
 */
export function createDeclarativeCandidateStrategies(
  toolkit: CandidateToolkit,
): Partial<Record<TreeSitterLanguage, CandidateStrategy>> {
  const {
    callRole,
    leadingDocumentationStart,
    makeRawRangeUnit,
    precedingCommentStart,
  } = toolkit;

  /** Extracts the type and labels from an HCL block node. */
  function hclBlockParts(source: string, node: SyntaxNode) {
    return node.namedChildren
      .filter(
        (child): child is SyntaxNode =>
          child !== null &&
          (child.type === "identifier" || child.type === "string_lit"),
      )
      .map((child) => {
        if (child.type === "identifier") return nodeText(source, child);
        const literal = syntaxDescendants(child).find(
          (part) => part.type === "template_literal",
        );
        return literal
          ? nodeText(source, literal)
          : nodeText(source, child).replace(/^"|"$/g, "");
      });
  }

  /** Extracts an HCL attribute's identifier. */
  function hclAttributeName(source: string, node: SyntaxNode) {
    const identifier = node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "identifier",
    );
    return identifier ? nodeText(source, identifier) : undefined;
  }

  /** Returns a literal template value assigned by an HCL attribute. */
  function hclAttributeLiteral(source: string, node: SyntaxNode) {
    const literal = syntaxDescendants(node).find(
      (child) => child.type === "template_literal",
    );
    return literal ? nodeText(source, literal) : undefined;
  }

  /** Includes contiguous HCL documentation comments before a node. */
  function hclDocumentationStart(source: string, node: SyntaxNode) {
    let start = leadingDocumentationStart(source, node, shapes.hcl, "hcl");
    if (start < node.startIndex) return start;

    let cursor = source.lastIndexOf("\n", node.startIndex - 1) + 1;
    while (cursor > 0) {
      const previousEnd = cursor - 1;
      const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
      const previousLine = source.slice(previousStart, previousEnd);
      if (/^\s*(?:#|\/\/)/.test(previousLine)) {
        start = previousStart;
        cursor = previousStart;
        continue;
      }
      if (previousLine.trimEnd().endsWith("*/")) {
        const commentEnd = previousEnd;
        const commentStart = source.lastIndexOf("/*", commentEnd);
        if (commentStart >= 0) {
          const lineStart = source.lastIndexOf("\n", commentStart - 1) + 1;
          if (source.slice(lineStart, commentStart).trim() === "") {
            start = lineStart;
            cursor = lineStart;
            continue;
          }
        }
      }
      break;
    }
    return start;
  }

  /** Returns the member path invoked by an ECMAScript call expression. */
  function ecmascriptCallPath(source: string, node: SyntaxNode): string[] {
    const target =
      node.type === "call_expression"
        ? node.childForFieldName("function")
        : node;
    if (!target) return [];
    if (
      [
        "identifier",
        "property_identifier",
        "private_property_identifier",
      ].includes(target.type)
    ) {
      return [nodeText(source, target)];
    }
    if (target.type === "call_expression") {
      return ecmascriptCallPath(source, target);
    }
    if (target.type === "member_expression") {
      const object = target.childForFieldName("object");
      const property = target.childForFieldName("property");
      return [
        ...(object ? ecmascriptCallPath(source, object) : []),
        ...(property ? [nodeText(source, property)] : []),
      ];
    }
    return [];
  }

  /** Returns the direct string label passed to an ECMAScript DSL call. */
  function ecmascriptCallLabel(source: string, node: SyntaxNode) {
    const argumentsNode = node.childForFieldName("arguments");
    const literal = argumentsNode?.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && ["string", "template_string"].includes(child.type),
    );
    if (!literal) return undefined;
    const content = syntaxDescendants(literal).find((child) =>
      ["string_fragment", "template_chars"].includes(child.type),
    );
    return content
      ? nodeText(source, content)
      : nodeText(source, literal).slice(1, -1);
  }

  /** Returns whether a call is the final invocation in a curried call chain. */
  function isOutermostEcmascriptCall(node: SyntaxNode) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type !== "call_expression") continue;
      const target = parent.childForFieldName("function");
      if (
        target &&
        target.startIndex <= node.startIndex &&
        target.endIndex >= node.endIndex
      ) {
        return false;
      }
      break;
    }
    return true;
  }

  type EcmascriptTestRole = {
    kind: "test" | "test_hook" | "test_suite";
    name: string;
  };

  /** Classifies one recognized ECMAScript test-framework invocation. */
  function ecmascriptTestRole(
    source: string,
    node: SyntaxNode,
    bindings: ReadonlyMap<string, string>,
    conventionalTestFile: boolean,
  ): EcmascriptTestRole | undefined {
    if (!isOutermostEcmascriptCall(node)) return undefined;
    const path = ecmascriptCallPath(source, node);
    const first = path[0];
    if (!first) return undefined;
    const explicitRuntime =
      (first === "Deno" || first === "Bun") && path[1] === "test";
    const canonical = bindings.get(first) ?? first;
    const recognized =
      explicitRuntime || bindings.has(first) || conventionalTestFile;
    if (!recognized) return undefined;

    const lowerPath = path.map((part) => part.toLowerCase());
    const canonicalLower = canonical.toLowerCase();
    if (lowerPath.includes("step") || lowerPath.includes("use"))
      return undefined;
    const suite =
      ["context", "describe", "feature"].includes(canonicalLower) ||
      lowerPath.includes("describe");
    const hook = [...lowerPath, canonicalLower].find((part) =>
      [
        "after",
        "afterall",
        "aftereach",
        "before",
        "beforeall",
        "beforeeach",
      ].includes(part),
    );
    if (suite) {
      const name = ecmascriptCallLabel(source, node);
      return name ? { kind: "test_suite", name } : undefined;
    }
    if (hook) {
      return {
        kind: "test_hook",
        name: hook
          .replace("beforeeach", "before each")
          .replace("aftereach", "after each")
          .replace("beforeall", "before all")
          .replace("afterall", "after all"),
      };
    }
    if (
      explicitRuntime ||
      ["it", "specify", "test"].includes(canonicalLower) ||
      canonicalLower === "ava"
    ) {
      const name = ecmascriptCallLabel(source, node);
      return name ? { kind: "test", name } : undefined;
    }
    return undefined;
  }

  /** Builds local-to-canonical test API bindings from ECMAScript imports. */
  function ecmascriptTestBindings(source: string, root: SyntaxNode) {
    const bindings = new Map<string, string>();
    const frameworkModules = new Set([
      "@jest/globals",
      "@playwright/test",
      "ava",
      "bun:test",
      "jest",
      "node:test",
      "vitest",
    ]);
    for (const statement of root.namedChildren) {
      if (statement?.type !== "import_statement") continue;
      const sourceNode = statement.childForFieldName("source");
      if (!sourceNode) continue;
      const fragment = syntaxDescendants(sourceNode).find(
        (child) => child.type === "string_fragment",
      );
      const moduleName = fragment ? nodeText(source, fragment) : undefined;
      if (!moduleName || !frameworkModules.has(moduleName)) continue;
      const clause = statement.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && child.type === "import_clause",
      );
      if (!clause) continue;
      for (const specifier of syntaxDescendants(clause).filter(
        (child) => child.type === "import_specifier",
      )) {
        const imported = specifier.childForFieldName("name");
        const local = specifier.childForFieldName("alias") ?? imported;
        if (imported && local) {
          bindings.set(nodeText(source, local), nodeText(source, imported));
        }
      }
      const defaultBinding = clause.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && child.type === "identifier",
      );
      if (defaultBinding) {
        bindings.set(
          nodeText(source, defaultBinding),
          moduleName === "ava" ? "ava" : "test",
        );
      }
    }
    return bindings;
  }

  /** Returns the callback-body start used to keep suite headers metadata-only. */
  function ecmascriptSuiteHeaderEnd(node: SyntaxNode) {
    const callback = syntaxDescendants(node).find((child) =>
      ["arrow_function", "function_expression"].includes(child.type),
    );
    return callback?.childForFieldName("body")?.startIndex ?? node.endIndex;
  }

  /** Applies test-framework semantics and setup grouping to ECMAScript units. */
  function specializeEcmascriptCandidates(
    file: SourceFile,
    language: "javascript" | "typescript",
    root: SyntaxNode,
    candidates: Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }>,
  ) {
    const source = file.content;
    const lowerPath = file.path.toLowerCase();
    const conventionalTestFile =
      lowerPath.includes(".test.") ||
      lowerPath.includes(".spec.") ||
      lowerPath.includes("/test/") ||
      lowerPath.includes("/tests/");
    const bindings = ecmascriptTestBindings(source, root);
    const calls = syntaxDescendants(root)
      .filter((node) => node.type === "call_expression")
      .map((node) => {
        const role = ecmascriptTestRole(
          source,
          node,
          bindings,
          conventionalTestFile,
        );
        return role ? { node, role } : undefined;
      })
      .filter(
        (
          value,
        ): value is {
          node: SyntaxNode;
          role: EcmascriptTestRole;
        } => value !== undefined,
      );
    const specialized = candidates.filter(
      ({ node, unit }) =>
        !(
          node.type === "call_expression" &&
          ["test", "test_hook", "test_suite"].includes(unit.kind)
        ),
    );
    const suites = calls.filter(({ role }) => role.kind === "test_suite");
    for (const { node, role } of calls) {
      if (role.kind === "test_suite") continue;
      const scopes = suites
        .filter(
          ({ node: suite }) =>
            suite.startIndex < node.startIndex &&
            suite.endIndex >= node.endIndex,
        )
        .sort((left, right) => left.node.startIndex - right.node.startIndex)
        .map(({ role: suiteRole }) => suiteRole.name);
      const name = [...scopes, role.name].join(" › ");
      specialized.push({
        node,
        ownName: role.name,
        unit: makeRawRangeUnit(
          file,
          language,
          role.kind,
          name,
          precedingCommentStart(source, node),
          node.endIndex,
        ),
      });
    }

    const topLevel = root.namedChildren.filter(
      (node): node is SyntaxNode => node !== null,
    );
    const topCalls = topLevel.flatMap((statement) => {
      const call =
        statement.type === "expression_statement"
          ? statement.namedChildren.find(
              (child): child is SyntaxNode =>
                child !== null && child.type === "call_expression",
            )
          : undefined;
      return call ? [{ statement, call }] : [];
    });
    const firstSuite = topCalls
      .map(({ statement, call }) => {
        const role = ecmascriptTestRole(
          source,
          call,
          bindings,
          conventionalTestFile,
        );
        return role?.kind === "test_suite"
          ? { statement, call, role }
          : undefined;
      })
      .filter(
        (value): value is NonNullable<typeof value> => value !== undefined,
      )
      .at(0);
    if (firstSuite) {
      const beforeSuite = topLevel.filter(
        (node) => node.endIndex <= firstSuite.statement.startIndex,
      );
      const declarationBeforeSuite = beforeSuite.filter(
        (node) =>
          !["comment", "import_statement"].includes(node.type) &&
          !(
            node.type === "expression_statement" &&
            node.namedChildren.every(
              (child) => child === null || child.type === "string",
            )
          ) &&
          !topCalls.some(
            ({ statement, call }) =>
              statement.startIndex === node.startIndex &&
              (ecmascriptTestRole(source, call, bindings, conventionalTestFile)
                ?.kind === "test_hook" ||
                ecmascriptCallPath(source, call).at(-1) === "use"),
          ),
      );
      const lifecycle = topCalls.filter(
        ({ statement, call }) =>
          statement.endIndex <= firstSuite.statement.startIndex &&
          ecmascriptTestRole(source, call, bindings, conventionalTestFile)
            ?.kind === "test_hook",
      );
      if (declarationBeforeSuite.length === 0) {
        const first = topLevel[0] ?? firstSuite.statement;
        specialized.push({
          node: firstSuite.call,
          ownName: "Test setup",
          unit: makeRawRangeUnit(
            file,
            language,
            "module",
            "Test setup",
            first.startIndex,
            ecmascriptSuiteHeaderEnd(firstSuite.call),
          ),
        });
        const lifecycleNodes = new Set(
          lifecycle.map(({ call }) => `${call.startIndex}:${call.endIndex}`),
        );
        for (let index = specialized.length - 1; index >= 0; index -= 1) {
          const candidate = specialized[index];
          if (
            candidate &&
            candidate.unit.kind === "test_hook" &&
            lifecycleNodes.has(
              `${candidate.node.startIndex}:${candidate.node.endIndex}`,
            )
          ) {
            specialized.splice(index, 1);
          }
        }
      } else if (lifecycle.length > 0) {
        const first = lifecycle[0];
        const last = lifecycle.at(-1);
        if (first && last) {
          specialized.push({
            node: first.call,
            ownName: "Test lifecycle",
            unit: makeRawRangeUnit(
              file,
              language,
              "test_hook",
              "Test lifecycle",
              first.statement.startIndex,
              last.statement.endIndex,
            ),
          });
          const lifecycleNodes = new Set(
            lifecycle.map(({ call }) => `${call.startIndex}:${call.endIndex}`),
          );
          for (let index = specialized.length - 1; index >= 0; index -= 1) {
            const candidate = specialized[index];
            if (
              candidate &&
              candidate.unit.name !== "Test lifecycle" &&
              candidate.unit.kind === "test_hook" &&
              lifecycleNodes.has(
                `${candidate.node.startIndex}:${candidate.node.endIndex}`,
              )
            ) {
              specialized.splice(index, 1);
            }
          }
        }
      }
    }

    if (
      specialized.length === 0 &&
      topLevel.some(
        (node) =>
          !["comment", "import_statement"].includes(node.type) &&
          nodeText(source, node).trim().length > 0,
      )
    ) {
      const first = topLevel.find(
        (node) => !["comment", "import_statement"].includes(node.type),
      );
      const last = topLevel.at(-1);
      if (first && last) {
        const reexportOnly = topLevel.every((node) =>
          ["comment", "export_statement", "import_statement"].includes(
            node.type,
          ),
        );
        const name = reexportOnly
          ? (file.path.split("/").at(-1) ?? file.path)
          : "Module statements";
        specialized.push({
          node: first,
          ownName: name,
          unit: makeRawRangeUnit(
            file,
            language,
            "module",
            name,
            first.startIndex,
            last.endIndex,
          ),
        });
      }
    }
    return specialized;
  }

  /** Extracts Terraform, test, variable, mapping, and generic HCL units. */
  function hclReviewCandidates(
    file: SourceFile,
    root: SyntaxNode,
  ): Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }> {
    const body = root.namedChildren.find(
      (child): child is SyntaxNode => child !== null && child.type === "body",
    );
    if (!body) {
      const meaningful = root.namedChildren.some(
        (node) =>
          node !== null &&
          !shapes.hcl.comments.has(node.type) &&
          nodeText(file.content, node).trim().length > 0,
      );
      if (!meaningful) return [];
      const node = root.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && !shapes.hcl.comments.has(child.type),
      );
      return node
        ? [
            {
              node,
              ownName: "statements",
              unit: makeRawRangeUnit(
                file,
                "hcl",
                "module",
                "HCL statements",
                0,
                file.content.length,
              ),
            },
          ]
        : [];
    }
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    const blockCounts = new Map<string, number>();
    /** Adds an HCL candidate with an explicit semantic range. */
    const add = (
      node: SyntaxNode,
      kind: UnitKind,
      name: string,
      ownName: string,
      from = hclDocumentationStart(file.content, node),
      to = node.endIndex,
    ) => {
      candidates.push({
        node,
        ownName,
        unit: makeRawRangeUnit(file, "hcl", kind, name, from, to),
      });
    };

    for (const node of body.namedChildren) {
      if (!node) continue;
      if (node.type === "attribute") {
        const attribute = hclAttributeName(file.content, node);
        if (!attribute) continue;
        add(
          node,
          "variable",
          file.path.endsWith(".tfvars") ? `Input ${attribute}` : attribute,
          file.path.endsWith(".tfvars") ? `var.${attribute}` : attribute,
        );
        continue;
      }
      if (node.type !== "block") continue;
      const [type, ...labels] = hclBlockParts(file.content, node);
      if (!type) continue;
      const nestedBody = node.namedChildren.find(
        (child): child is SyntaxNode => child !== null && child.type === "body",
      );
      const directAttributes =
        nestedBody?.namedChildren.filter(
          (child): child is SyntaxNode =>
            child !== null && child.type === "attribute",
        ) ?? [];
      const directBlocks =
        nestedBody?.namedChildren.filter(
          (child): child is SyntaxNode =>
            child !== null && child.type === "block",
        ) ?? [];

      if (file.path.endsWith(".tftest.hcl")) {
        if (type === "terraform") {
          add(node, "test_suite", "Terraform test configuration", "terraform");
        } else if (type === "mock_provider") {
          add(
            node,
            "test_hook",
            `mock provider ${labels[0] ?? ""}`.trim(),
            type,
          );
        } else if (type === "variables") {
          add(node, "test_hook", "variables", type);
        } else if (type === "run") {
          add(
            node,
            "test",
            `Run ${labels[0] ?? ""}`.trim(),
            `run.${labels[0]}`,
          );
        } else {
          add(node, "module", [type, ...labels].join(" "), type);
        }
        continue;
      }

      if (type === "terraform") {
        add(node, "module", "Terraform configuration", "terraform");
      } else if (type === "variable") {
        const label = labels[0] ?? "";
        add(node, "variable", `Variable ${label}`.trim(), `var.${label}`);
      } else if (type === "provider") {
        const provider = labels[0] ?? "";
        const aliasNode = directAttributes.find(
          (attribute) => hclAttributeName(file.content, attribute) === "alias",
        );
        const alias = aliasNode
          ? hclAttributeLiteral(file.content, aliasNode)
          : undefined;
        add(
          node,
          "module",
          `Provider ${provider}${alias ? `.${alias}` : ""}`,
          `provider.${provider}${alias ? `.${alias}` : ""}`,
        );
      } else if (type === "locals") {
        for (const attribute of directAttributes) {
          const name = hclAttributeName(file.content, attribute);
          if (name)
            add(attribute, "variable", `Local ${name}`, `local.${name}`);
        }
      } else if (type === "data") {
        const address = labels.slice(0, 2).join(".");
        add(node, "variable", `Data ${address}`, `data.${address}`);
      } else if (type === "resource") {
        const address = labels.slice(0, 2).join(".");
        const dynamicBlocks = directBlocks.filter(
          (block) => hclBlockParts(file.content, block)[0] === "dynamic",
        );
        if (directAttributes.length > 0 || dynamicBlocks.length === 0) {
          add(node, "module", address, address);
        }
        for (const dynamic of dynamicBlocks) {
          const dynamicLabel = hclBlockParts(file.content, dynamic)[1] ?? "";
          add(
            dynamic,
            "module",
            `${address} › Dynamic ${dynamicLabel}`.trim(),
            `${address}.dynamic.${dynamicLabel}`,
            node.startIndex,
            dynamic.endIndex,
          );
        }
      } else if (type === "module") {
        const label = labels[0] ?? "";
        add(node, "module", `Module ${label}`, `module.${label}`);
      } else if (type === "output") {
        const label = labels[0] ?? "";
        add(node, "variable", `Output ${label}`, `output.${label}`);
      } else if (type === "check") {
        const label = labels[0] ?? "";
        const assertions = directBlocks.filter(
          (block) => hclBlockParts(file.content, block)[0] === "assert",
        );
        for (const [index, assertion] of assertions.entries()) {
          add(
            assertion,
            "test",
            `Check ${label} › Assertion ${index + 1}`,
            `check.${label}.assert.${index + 1}`,
          );
        }
      } else if (type === "moved" || type === "import") {
        const next = (blockCounts.get(type) ?? 0) + 1;
        blockCounts.set(type, next);
        add(
          node,
          "module",
          `${type === "moved" ? "Moved" : "Import"} mapping ${next}`,
          `${type}.${next}`,
        );
      } else {
        add(node, "module", [type, ...labels].join(" "), type);
      }
    }

    if (
      candidates.length === 0 &&
      body.namedChildren.some(
        (node) =>
          node !== null &&
          !shapes.hcl.comments.has(node.type) &&
          nodeText(file.content, node).trim().length > 0,
      )
    ) {
      add(
        body,
        "module",
        "HCL statements",
        "statements",
        0,
        file.content.length,
      );
    }
    return candidates;
  }

  /** Returns the macro name invoked by an Elixir call form. */
  function elixirCallForm(source: string, node: SyntaxNode) {
    if (node.type !== "call") return undefined;
    const target = node.namedChildren[0];
    return target?.type === "identifier" ? nodeText(source, target) : undefined;
  }

  /** Returns the argument nodes written on an Elixir call form. */
  function elixirArgumentNodes(node: SyntaxNode) {
    const argumentList = node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "arguments",
    );
    return (
      argumentList?.namedChildren.filter(
        (child): child is SyntaxNode => child !== null,
      ) ?? []
    );
  }

  /** Returns the name and arity declared by an Elixir definition head. */
  function elixirDefinitionHead(source: string, node: SyntaxNode) {
    let head: SyntaxNode | null | undefined = elixirArgumentNodes(node)[0];
    // `def fetch(id) when is_integer(id)` wraps the head in the guard operator.
    while (head?.type === "binary_operator") head = head.namedChildren[0];
    if (head?.type === "identifier") {
      return { name: nodeText(source, head), arity: 0 };
    }
    if (head?.type !== "call") return undefined;
    const name = elixirCallForm(source, head);
    return name ? { name, arity: elixirArgumentNodes(head).length } : undefined;
  }

  /** Returns the module path declared by an Elixir container form. */
  function elixirContainerLabel(
    source: string,
    node: SyntaxNode,
    form: string,
  ) {
    const alias = elixirArgumentNodes(node)[0];
    if (!alias) return undefined;
    const declared = nodeText(source, alias);
    if (form !== "defimpl") return declared;
    const keywords = elixirArgumentNodes(node).find(
      (argument) => argument.type === "keywords",
    );
    for (const pair of keywords?.namedChildren ?? []) {
      if (pair?.type !== "pair") continue;
      const [keyword, target] = pair.namedChildren;
      if (!keyword || !target) continue;
      if (nodeText(source, keyword).replace(/[:\s]+$/, "") !== "for") continue;
      // `defimpl Sizeable, for: List` compiles to the module `Sizeable.List`, and
      // both halves are needed or every implementation of one protocol collides.
      return `${declared}.${nodeText(source, target)}`;
    }
    return declared;
  }

  /**
   * Elixir annotations describe the definition written under them, unlike module
   * attributes such as `@timeout 5_000` that hold module-level values, so only
   * these may be absorbed into the following definition's review range.
   */
  const elixirAnnotationAttributes = set(
    "deprecated",
    "describetag",
    "doc",
    "impl",
    "since",
    "spec",
    "tag",
    "typedoc",
  );

  /** Includes contiguous Elixir comments and annotations before a definition. */
  function elixirDocumentationStart(source: string, node: SyntaxNode) {
    let start = node.startIndex;
    for (
      let sibling = node.previousNamedSibling;
      sibling;
      sibling = sibling.previousNamedSibling
    ) {
      if (source.slice(sibling.endIndex, start).trim() !== "") break;
      const annotation =
        sibling.type === "unary_operator" &&
        elixirAnnotationAttributes.has(
          /^@(\w+)/.exec(nodeText(source, sibling))?.[1] ?? "",
        );
      if (!annotation && !shapes.elixir.comments.has(sibling.type)) break;
      start = sibling.startIndex;
    }
    return start;
  }

  const elixirContainerForms = set("defimpl", "defmodule", "defprotocol");

  const elixirFunctionForms = set(
    "def",
    "defdelegate",
    "defguard",
    "defguardp",
    "defmacro",
    "defmacrop",
    "defp",
  );

  const elixirPrivateForms = set("defguardp", "defmacrop", "defp");

  const elixirStructForms = set("defexception", "defstruct");

  /** Extracts Elixir modules, definitions, struct shapes, and ExUnit tests. */
  function elixirReviewCandidates(
    file: SourceFile,
    root: SyntaxNode,
  ): Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }> {
    const source = file.content;
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    /** Adds an Elixir candidate with an explicit semantic range. */
    const add = (
      node: SyntaxNode,
      kind: UnitKind,
      name: string,
      ownName: string,
      start = elixirDocumentationStart(source, node),
      end = node.endIndex,
    ) => {
      candidates.push({
        node,
        ownName,
        unit: makeRawRangeUnit(file, "elixir", kind, name, start, end),
      });
    };

    /** Collects every definition written directly inside one `do` block. */
    const visit = (block: SyntaxNode, scopes: string[], suites: string[]) => {
      let clauses:
        | {
            node: SyntaxNode;
            name: string;
            ownName: string;
            start: number;
            end: number;
          }
        | undefined;
      /** Emits the pending function clauses as one reviewable definition. */
      const flush = () => {
        if (!clauses) return;
        const { node, name, ownName, start, end } = clauses;
        add(node, "function", name, ownName, start, end);
        clauses = undefined;
      };

      for (const node of block.namedChildren) {
        const form = node ? elixirCallForm(source, node) : undefined;
        if (!node || !form) continue;
        if (elixirFunctionForms.has(form)) {
          const head = elixirDefinitionHead(source, node);
          if (!head) continue;
          const name = `${[...scopes, `${head.name}/${head.arity}`].join(".")}${
            elixirPrivateForms.has(form) ? " (private)" : ""
          }`;
          // Pattern-matched clauses share one name and arity, so they are a
          // single definition rather than several identically titled cards.
          if (clauses?.name === name) {
            clauses.end = node.endIndex;
            continue;
          }
          flush();
          clauses = {
            node,
            name,
            ownName: head.name,
            start: elixirDocumentationStart(source, node),
            end: node.endIndex,
          };
          continue;
        }
        const declaration =
          elixirContainerForms.has(form) || elixirStructForms.has(form);
        const role = declaration ? undefined : callRole(source, node);
        if (!declaration && !role) continue;
        flush();
        const body = node.namedChildren.find(
          (child): child is SyntaxNode =>
            child !== null && child.type === "do_block",
        );
        if (role) {
          add(node, role.kind, [...suites, role.name].join(" › "), role.name);
          if (body && role.kind === "test_suite") {
            visit(body, scopes, [...suites, role.name]);
          }
          continue;
        }
        if (elixirStructForms.has(form)) {
          const owner = scopes.join(".");
          if (owner) add(node, "class", `%${owner}{}`, `%${owner}{}`);
          continue;
        }
        const label = elixirContainerLabel(source, node, form);
        if (!label) continue;
        const nested = [...scopes, label];
        const qualified = nested.join(".");
        const suite =
          form === "defmodule" &&
          ((/Test$/.test(label) && file.path.toLowerCase().includes("test")) ||
            (body?.namedChildren.some(
              (child) =>
                child !== null &&
                elixirCallForm(source, child) === "use" &&
                /\bExUnit\.Case\b/.test(nodeText(source, child)),
            ) ??
              false));
        add(
          node,
          suite ? "test_suite" : form === "defmodule" ? "module" : "class",
          qualified,
          label,
        );
        if (body) visit(body, nested, [...suites, qualified]);
      }
      flush();
    };

    visit(root, [], []);
    return candidates;
  }

  /** Returns the significant forms of a Clojure list, ignoring comments. */
  function clojureListForms(node: SyntaxNode) {
    return node.namedChildren.filter(
      (child): child is SyntaxNode =>
        child !== null && !shapes.clojure.comments.has(child.type),
    );
  }

  /** Returns the name declared by a Clojure symbol or keyword literal. */
  function clojureDeclaredName(source: string, node: SyntaxNode) {
    if (node.type === "kwd_lit") return nodeText(source, node);
    if (node.type !== "sym_lit") return undefined;
    const name = node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "sym_name",
    );
    return name ? nodeText(source, name) : undefined;
  }

  /** Reports whether a Clojure definition is private by form or by metadata. */
  function clojurePrivateDefinition(
    source: string,
    form: string,
    name: SyntaxNode,
  ) {
    return (
      form.endsWith("-") ||
      name.namedChildren.some(
        (child) =>
          child !== null &&
          child.type === "meta_lit" &&
          /:private\b/.test(nodeText(source, child)),
      )
    );
  }

  const clojureContainerForms = set(
    "definterface",
    "defprotocol",
    "defrecord",
    "defstruct",
    "deftype",
  );

  const clojureConstantForms = set("def", "defonce");

  const clojureFunctionForms = set("defmacro", "defmulti", "defn", "defn-");

  /** Maps a Clojure definition form to the review kind it declares. */
  function clojureFormKind(form: string): UnitKind {
    if (clojureContainerForms.has(form)) return "class";
    if (clojureConstantForms.has(form)) return "constant";
    if (form === "deftest") return "test";
    if (form === "defmethod") return "method";
    if (clojureFunctionForms.has(form)) return "function";
    // Projects define their own `def*` macros freely; an unknown one still binds
    // a namespace-level var, so it stays reviewable under its declared name.
    return "variable";
  }

  /** Extracts Clojure namespaces, definitions, protocol members, and tests. */
  function clojureReviewCandidates(
    file: SourceFile,
    root: SyntaxNode,
  ): Array<{ node: SyntaxNode; unit: RawUnit; ownName: string }> {
    const source = file.content;
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    /** Adds a Clojure candidate with an explicit semantic range. */
    const add = (
      node: SyntaxNode,
      kind: UnitKind,
      name: string,
      own: string,
    ) => {
      candidates.push({
        node,
        ownName: own,
        unit: makeRawRangeUnit(
          file,
          "clojure",
          kind,
          name,
          leadingDocumentationStart(source, node, shapes.clojure, "clojure"),
          node.endIndex,
        ),
      });
    };

    for (const node of root.namedChildren) {
      if (node?.type !== "list_lit") continue;
      const forms = clojureListForms(node);
      const head = forms[0];
      const form = head ? clojureDeclaredName(source, head) : undefined;
      const target = forms[1];
      const declared = target ? clojureDeclaredName(source, target) : undefined;
      if (!form || !declared) continue;
      if (form === "ns") {
        add(node, "module", `Namespace ${declared}`, declared);
        continue;
      }
      if (!form.startsWith("def")) continue;
      // A multimethod contributes one implementation per dispatch value, so the
      // dispatch value belongs in the title to keep the cards distinguishable.
      const dispatch =
        form === "defmethod" && forms[2]
          ? ` ${nodeText(source, forms[2]).replace(/\s+/g, " ")}`
          : "";
      const visibility =
        target && clojurePrivateDefinition(source, form, target)
          ? " (private)"
          : "";
      const kind = clojureFormKind(form);
      add(node, kind, `${declared}${dispatch}${visibility}`, declared);
      if (kind !== "class") continue;
      for (const member of forms.slice(2)) {
        if (member.type !== "list_lit") continue;
        const memberHead = clojureListForms(member)[0];
        const method = memberHead
          ? clojureDeclaredName(source, memberHead)
          : undefined;
        if (method) add(member, "method", `${declared}.${method}`, method);
      }
    }
    return candidates;
  }
  /** Strips the quoting a document format wraps around a token. */

  return {
    clojure: { extract: clojureReviewCandidates },
    elixir: { extract: elixirReviewCandidates },
    hcl: { extract: hclReviewCandidates },
    javascript: {
      specialize: (file, _language, root, candidates) =>
        specializeEcmascriptCandidates(file, "javascript", root, candidates),
    },
    typescript: {
      specialize: (file, _language, root, candidates) =>
        specializeEcmascriptCandidates(file, "typescript", root, candidates),
    },
  };
}
