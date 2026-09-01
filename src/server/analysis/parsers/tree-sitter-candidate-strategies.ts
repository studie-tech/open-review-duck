import type { Node as SyntaxNode } from "web-tree-sitter";
import { stableReviewKey } from "../hash";
import {
  nodeText,
  syntaxDescendants,
  type TreeSitterLanguage,
} from "../tree-sitter";
import type { RawUnit, SourceFile, UnitKind } from "../types";
import type {
  CandidateStrategy,
  CandidateToolkit,
} from "./tree-sitter-candidate-types";
import { createDeclarativeCandidateStrategies } from "./tree-sitter-candidates/declarative";
import { createScriptingCandidateStrategies } from "./tree-sitter-candidates/scripting";
import { type LanguageShape, shapes } from "./tree-sitter-language-shapes";

/**
 * Builds the complete language strategy registry and candidate extractor.
 *
 * Languages without a strategy use the common declaration walk; strategies
 * either replace that walk or specialize its result.
 */
export function createCandidateExtractor(toolkit: CandidateToolkit) {
  const {
    annotationText,
    bodyNode,
    callRole,
    candidateKind,
    cppDeclarationName,
    declarationScopes,
    enclosingContainer,
    isCppModuleContextNode,
    isHeaderGuardDefinition,
    isNestedImplementation,
    isPhpImportNode,
    leadingDocumentationStart,
    makeRawRangeUnit,
    makeRawUnit,
    nestedEcmascriptCandidate,
    ownName,
    syntaxAncestors,
    testRole,
  } = toolkit;
  const scripting = createScriptingCandidateStrategies(toolkit);
  const strategies: Partial<Record<TreeSitterLanguage, CandidateStrategy>> = {
    ...scripting.strategies,
    ...createDeclarativeCandidateStrategies(toolkit),
  };

  /** Strips the quoting a document format wraps around a token. */
  function unquoteToken(value: string) {
    return value.replace(/^["']|["']$/g, "");
  }

  /** Returns the sections reachable from a node without crossing a section. */
  function sectionChildren(
    node: SyntaxNode,
    sections: ReadonlySet<string>,
  ): SyntaxNode[] {
    return node.namedChildren.flatMap((child) =>
      child === null
        ? []
        : sections.has(child.type)
          ? [child]
          : sectionChildren(child, sections),
    );
  }

  /** Returns the label a section leads with, such as a key or a tag name. */
  function sectionLabel(
    source: string,
    node: SyntaxNode,
    sections: ReadonlySet<string>,
  ) {
    const header = node.firstNamedChild;
    if (!header || sections.has(header.type)) return undefined;
    let leaf = header;
    while (leaf.firstNamedChild) leaf = leaf.firstNamedChild;
    return unquoteToken(nodeText(source, leaf)).trim() || undefined;
  }

  /** Returns the scalar a section carries, ignoring tokens repeating its label. */
  function sectionValue(source: string, node: SyntaxNode, label: string) {
    const values = syntaxDescendants(node)
      .filter((descendant) => descendant.namedChildCount === 0)
      .map((leaf) => unquoteToken(nodeText(source, leaf)).trim())
      .filter((text) => text.length > 0 && text !== label);
    return values.at(-1);
  }

  /**
   * Matches the labels a document format uses to identify a record, covering
   * bare keys (`name`), compound keys (`artifactId`) and markup locators (`src`).
   */
  const identifyingLabel =
    /^(?:id|name|key|src|href)$|[a-z_.-](?:id|name|key)$/i;

  /** Returns the identity a section publishes through attributes or fields. */
  function sectionIdentity(
    source: string,
    node: SyntaxNode,
    sections: ReadonlySet<string>,
  ) {
    const header = node.firstNamedChild;
    const attributes =
      header && !sections.has(header.type)
        ? header.namedChildren.filter(
            (child): child is SyntaxNode =>
              child !== null && /attribute/i.test(child.type),
          )
        : [];
    const values = [...attributes, ...sectionChildren(node, sections)].flatMap(
      (descriptor) => {
        const label = sectionLabel(source, descriptor, sections);
        if (!label || !identifyingLabel.test(label)) return [];
        const value = sectionValue(source, descriptor, label);
        return value ? [value] : [];
      },
    );
    return values.join(":") || undefined;
  }

  /** Returns the outline of a document, looking past its whole-file wrapper. */
  function documentOutline(root: SyntaxNode, sections: ReadonlySet<string>) {
    const outline = sectionChildren(root, sections);
    const [wrapper] = outline;
    // A lone section is the file itself — the root element — so the sections it
    // holds are what a reviewer signs off. Looking any deeper would review the
    // contents of a section instead of the section.
    return outline.length === 1 && wrapper
      ? sectionChildren(wrapper, sections)
      : outline;
  }

  /** Extracts review candidates for hierarchical markup documents. */
  function documentReviewCandidates(
    file: SourceFile,
    language: TreeSitterLanguage,
    root: SyntaxNode,
    shape: LanguageShape,
    sections: ReadonlySet<string>,
  ) {
    const outline = documentOutline(root, sections).filter(
      // Markup nests text leaves for presentation, so only sections that hold
      // further structure earn a card.
      (node) => sectionChildren(node, sections).length > 0,
    );
    const embedded = syntaxDescendants(root).filter((node) =>
      Boolean(shape.moduleUnits?.has(node.type)),
    );
    const entries = [
      ...outline.map((node) => ({ node, kind: "module" as UnitKind })),
      // Embedded code carries its own risk wherever it sits, so it is reviewed
      // apart from the section it is nested in.
      ...embedded.map((node) => ({ node, kind: "module" as UnitKind })),
    ].sort((left, right) => left.node.startIndex - right.node.startIndex);
    const labels = entries.map(({ node }) =>
      sectionLabel(file.content, node, sections),
    );
    const labelCounts = new Map<string, number>();
    for (const label of labels) {
      labelCounts.set(label ?? "", (labelCounts.get(label ?? "") ?? 0) + 1);
    }
    const ordinals = new Map<string, number>();
    return entries.map(({ node, kind }, index) => {
      const label = labels[index];
      const group = label ?? "";
      const ordinal = (ordinals.get(group) ?? 0) + 1;
      ordinals.set(group, ordinal);
      const ambiguous = (labelCounts.get(group) ?? 0) > 1;
      const identity =
        ambiguous || !label
          ? sectionIdentity(file.content, node, sections)
          : undefined;
      // Repeated tags share a label, so a reviewer can only tell two cards apart
      // once the record's own identity — or its position — is part of the title.
      const name = label
        ? ambiguous
          ? `${label} ${identity ?? `#${ordinal}`}`
          : label
        : (identity ?? `Entry ${ordinal}`);
      return {
        node,
        ownName: label ?? name,
        unit: makeRawRangeUnit(
          file,
          language,
          kind,
          name,
          leadingDocumentationStart(file.content, node, shape, language),
          node.endIndex,
        ),
      };
    });
  }

  /** Extracts language-aware declaration candidates from one syntax tree. */
  function declarationCandidates(
    file: SourceFile,
    language: TreeSitterLanguage,
    root: SyntaxNode,
  ) {
    const shape = shapes[language];
    const extractor = strategies[language]?.extract;
    if (extractor) return extractor(file, root);
    if (shape.sections) {
      return documentReviewCandidates(
        file,
        language,
        root,
        shape,
        shape.sections,
      );
    }
    const candidates: Array<{
      node: SyntaxNode;
      unit: RawUnit;
      ownName: string;
    }> = [];
    for (const node of syntaxDescendants(root)) {
      if (language === "javascript" || language === "typescript") {
        const nested = nestedEcmascriptCandidate(file, language, node);
        if (nested) {
          candidates.push(nested);
          continue;
        }
      }
      if (
        (language === "c" || language === "cpp") &&
        isHeaderGuardDefinition(file.content, node)
      ) {
        continue;
      }
      if (language === "cpp" && isCppModuleContextNode(file.content, node)) {
        continue;
      }
      if (isNestedImplementation(language, node, shape, file.content)) continue;
      let kind = candidateKind(language, node, shape, file.content);
      let name =
        language === "cpp"
          ? cppDeclarationName(file.content, node)
          : language === "c" &&
              /\bSTART_TEST\s*\(\s*([A-Za-z_]\w*)\s*\)/.test(
                nodeText(file.content, node),
              )
            ? /\bSTART_TEST\s*\(\s*([A-Za-z_]\w*)\s*\)/.exec(
                nodeText(file.content, node),
              )?.[1]
            : language === "c" &&
                /\bTest\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/.test(
                  nodeText(file.content, node),
                )
              ? /\bTest\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/
                  .exec(nodeText(file.content, node))
                  ?.slice(1)
                  .join(" › ")
              : language === "python" && node.type === "type_alias_statement"
                ? /\btype\s+([A-Za-z_]\w*)/.exec(
                    nodeText(file.content, node),
                  )?.[1]
                : language === "csharp" &&
                    node.type === "conversion_operator_declaration"
                  ? /\b(implicit|explicit)\s+operator\s+([^\s(]+)/
                      .exec(nodeText(file.content, node))
                      ?.slice(1)
                      .join(" operator ")
                  : language === "csharp" &&
                      node.type === "operator_declaration"
                    ? `operator ${
                        /\boperator\s+([^\s(]+)/.exec(
                          nodeText(file.content, node),
                        )?.[1] ?? "?"
                      }`
                    : ownName(file.content, node);
      const call = [
        "call",
        "call_expression",
        "function_call",
        "function_call_expression",
        "command",
      ].includes(node.type)
        ? callRole(file.content, node)
        : undefined;
      if (call) {
        kind = call.kind;
        name =
          language === "php" && call.kind === "test_hook"
            ? call.name.toLowerCase()
            : language === "kotlin" && call.kind === "test_hook"
              ? call.name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
              : call.name;
      }
      // A module unit is located by where it sits, not by an identifier, so one
      // the grammar names nothing for still deserves a card. Any other nameless
      // declaration is an anonymous literal its owning declaration already covers.
      if (!name && shape.moduleUnits?.has(node.type)) {
        name = node.type.replaceAll("_", " ");
      }
      if (!kind || !name) continue;
      const scopes = declarationScopes(language, file.content, node, shape);
      const stableOwnName =
        language === "rust" && node.type === "impl_item"
          ? file.content
              .slice(
                node.startIndex,
                node.childForFieldName("body")?.startIndex ?? node.endIndex,
              )
              .replace(/\s+/g, " ")
              .trim()
          : name;
      const stableName = [...scopes, stableOwnName].join(
        language === "cpp" || language === "rust" ? "::" : ".",
      );
      const role = testRole(file, language, node, name, file.content);
      if (role) kind = role;
      if (language === "python" && kind === "test_suite") continue;
      const testLabel =
        role === "test" && language === "csharp"
          ? /(?:DisplayName|TestName)\s*=\s*"([^"]+)"/i.exec(
              annotationText(file.content, language, node),
            )?.[1]
          : undefined;
      const rustDisplayOwner =
        language === "rust"
          ? syntaxAncestors(node).find((parent) =>
              [
                "enum_item",
                "foreign_mod_item",
                "impl_item",
                "struct_item",
                "trait_item",
                "union_item",
              ].includes(parent.type),
            )
          : undefined;
      const displayScopes =
        language === "cpp"
          ? enclosingContainer(file.content, node, shape)
          : language === "rust" && rustDisplayOwner
            ? [ownName(file.content, rustDisplayOwner)].filter(
                (value): value is string => Boolean(value),
              )
            : language === "rust"
              ? []
              : scopes;
      const displayName =
        kind === "constant" || kind === "variable"
          ? [
              ...(language === "kotlin"
                ? displayScopes
                : displayScopes.slice(-1)),
              name,
            ].join(
              language === "cpp"
                ? "::"
                : language === "rust" &&
                    (node.type === "enum_variant" ||
                      ["impl_item", "trait_item"].includes(
                        syntaxAncestors(node).find((parent) =>
                          ["impl_item", "trait_item"].includes(parent.type),
                        )?.type ?? "",
                      ))
                  ? "::"
                  : ".",
            )
          : language === "rust" && kind === "method" && scopes.length > 0
            ? [...scopes.slice(-1), name].join("::")
            : language === "rust" &&
                kind === "function" &&
                node.type === "let_declaration"
              ? [...scopes.slice(-1), name].join("::")
              : language === "cpp" &&
                  ["method", "test_hook"].includes(kind) &&
                  displayScopes.length > 0
                ? [...displayScopes.slice(-1), name].join("::")
                : language === "php" &&
                    kind === "test_hook" &&
                    scopes.length > 0
                  ? [...scopes.slice(-1), name].join(" › ")
                  : language === "rust" && kind === "test"
                    ? name
                    : language === "kotlin" &&
                        kind === "class" &&
                        scopes.length > 0
                      ? [...scopes, name].join(".")
                      : language === "kotlin" &&
                          kind === "test_hook" &&
                          scopes.length > 0
                        ? [...scopes, name].join(" › ")
                        : language === "kotlin" && kind === "method"
                          ? node.type === "anonymous_initializer"
                            ? `${scopes.at(-1) ?? ""} init block`.trim()
                            : node.type === "secondary_constructor"
                              ? `${scopes.at(-1) ?? ""} constructor`.trim()
                              : [...scopes, name].join(".")
                          : language === "kotlin" &&
                              kind === "function" &&
                              scopes.length > 0
                            ? [...scopes, name].join(".")
                            : language === "go" &&
                                (kind === "test" || kind === "test_hook") &&
                                scopes.length > 0
                              ? [...scopes.slice(-1), name].join(".")
                              : kind === "test"
                                ? [
                                    ...(language === "kotlin" ||
                                    language === "python"
                                      ? scopes
                                      : scopes.slice(-1)),
                                    testLabel ?? name,
                                  ].join(" › ")
                                : language === "go" && kind === "method"
                                  ? [...scopes.slice(-1), name].join(".")
                                  : language === "go" &&
                                      kind === "function" &&
                                      node.type === "short_var_declaration"
                                    ? [...scopes.slice(-1), name].join(".")
                                    : kind === "test_hook" &&
                                        (language === "java" ||
                                          language === "python") &&
                                        scopes.length > 0
                                      ? [...scopes.slice(-1), name].join(" › ")
                                      : kind === "module" &&
                                          language === "java" &&
                                          node.type === "static_initializer"
                                        ? `${scopes.at(-1) ?? ""} static initializer`.trim()
                                        : kind === "module" &&
                                            language === "java" &&
                                            node.type === "block"
                                          ? `${scopes.at(-1) ?? ""} instance initializer`.trim()
                                          : kind === "method" &&
                                              node.type.includes("constructor")
                                            ? language === "csharp"
                                              ? (scopes.at(-1) ?? name)
                                              : `${scopes.at(-1) ?? name} constructor`
                                            : language === "php" &&
                                                kind === "method" &&
                                                name === "__construct"
                                              ? `${scopes.at(-1) ?? name} constructor`
                                              : name;
      const pythonBddStatement =
        language === "python" && kind === "test" && node.type === "call"
          ? syntaxAncestors(node).find(
              (parent) => parent.type === "with_statement",
            )
          : undefined;
      candidates.push({
        node,
        ownName: name,
        unit: pythonBddStatement
          ? makeRawRangeUnit(
              file,
              language,
              kind,
              displayName,
              node.startIndex,
              pythonBddStatement.endIndex,
            )
          : makeRawUnit(
              file,
              language,
              shape,
              node,
              kind,
              displayName,
              stableName,
            ),
      });
    }
    const specializer = strategies[language]?.specialize;
    if (specializer) return specializer(file, language, root, candidates);
    if (language === "csharp") {
      const statements = root.namedChildren.filter(
        (node): node is SyntaxNode =>
          node !== null && node.type === "global_statement",
      );
      const first = statements[0];
      const last = statements.at(-1);
      if (first && last) {
        const retained = candidates.filter(
          ({ node }) =>
            node.endIndex <= first.startIndex ||
            node.startIndex >= last.endIndex,
        );
        retained.push({
          node: first,
          ownName: "Top-level statements",
          unit: makeRawRangeUnit(
            file,
            language,
            "module",
            "Top-level statements",
            first.startIndex,
            last.endIndex,
          ),
        });
        return retained;
      }
    }
    if (language === "go") {
      let specialized = candidates;
      for (const declaration of syntaxDescendants(root).filter(
        (node) => node.type === "const_declaration",
      )) {
        const specs = syntaxDescendants(declaration).filter(
          (node) => node.type === "const_spec",
        );
        const first = specs[0];
        if (
          specs.length < 2 ||
          !first ||
          !nodeText(file.content, first).includes("iota")
        ) {
          continue;
        }
        const specRanges = new Set(
          specs.map((spec) => `${spec.startIndex}:${spec.endIndex}`),
        );
        specialized = specialized.filter(
          ({ node }) => !specRanges.has(`${node.startIndex}:${node.endIndex}`),
        );
        const firstName = ownName(file.content, first);
        if (!firstName) continue;
        const name = `${firstName} constants`;
        specialized.push({
          node: declaration,
          ownName: firstName,
          unit: makeRawRangeUnit(
            file,
            language,
            "constant",
            name,
            declaration.startIndex,
            declaration.endIndex,
          ),
        });
      }
      return specialized;
    }
    if (language === "c") {
      const definitions = new Set(
        candidates
          .filter(({ node }) => node.type === "function_definition")
          .map(({ ownName }) => ownName),
      );
      return candidates
        .filter(({ node, ownName }) => {
          if (node.type !== "declaration") return true;
          if (
            !syntaxDescendants(node).some((child) =>
              child.type.includes("function_declarator"),
            )
          ) {
            return true;
          }
          const text = nodeText(file.content, node);
          return (
            !definitions.has(ownName) &&
            (!/\bstatic\b/.test(text) || file.path.endsWith(".h"))
          );
        })
        .map((candidate) => {
          if (
            candidate.node.type === "declaration" &&
            syntaxDescendants(candidate.node).some((child) =>
              child.type.includes("function_declarator"),
            )
          ) {
            candidate.unit.stableKey = stableReviewKey(
              file.path,
              "prototype",
              candidate.ownName,
            );
          }
          return candidate;
        });
    }
    if (language === "cpp") {
      const specialized = [...candidates];
      for (const statement of root.namedChildren.filter(
        (node): node is SyntaxNode =>
          node !== null && node.type === "expression_statement",
      )) {
        const call = statement.namedChildren.find(
          (node): node is SyntaxNode =>
            node !== null && node.type === "call_expression",
        );
        const functionNode = call?.childForFieldName("function");
        if (
          !call ||
          !functionNode ||
          nodeText(file.content, functionNode) !== "TEST_CASE"
        ) {
          continue;
        }
        const label = syntaxDescendants(call).find(
          (node) => node.type === "string_content",
        );
        const name = label ? nodeText(file.content, label) : undefined;
        const body =
          statement.nextNamedSibling?.type === "compound_statement"
            ? statement.nextNamedSibling
            : undefined;
        if (!name || !body) continue;
        specialized.push({
          node: statement,
          ownName: name,
          unit: makeRawRangeUnit(
            file,
            language,
            "test",
            name,
            statement.startIndex,
            body.endIndex,
          ),
        });
      }
      for (const namespace of syntaxDescendants(root).filter(
        (node) => node.type === "namespace_definition",
      )) {
        const nameNode = namespace.childForFieldName("name");
        const namespaceName = nameNode
          ? nodeText(file.content, nameNode).split("::").at(-1)
          : undefined;
        const body = namespace.childForFieldName("body");
        const statements = body?.namedChildren.filter(
          (node): node is SyntaxNode =>
            node !== null && node.type === "expression_statement",
        );
        const first = statements?.[0];
        const last = statements?.at(-1);
        if (!namespaceName || !first || !last) continue;
        const name = `${namespaceName} namespace statements`;
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
      return specialized;
    }
    if (language === "php") {
      let specialized = candidates;
      const namespace = root.namedChildren.find(
        (node): node is SyntaxNode =>
          node !== null && node.type === "namespace_definition",
      );
      const namespaceNameNode = namespace?.childForFieldName("name");
      const namespaceName = namespaceNameNode
        ? nodeText(file.content, namespaceNameNode).split("\\").at(-1)
        : undefined;
      const body = namespace?.childForFieldName("body");
      const topLevel = body?.namedChildren ?? root.namedChildren;
      const setup = topLevel.filter((node): node is SyntaxNode => {
        if (!node || isPhpImportNode(node)) return false;
        if (
          ![
            "do_statement",
            "echo_statement",
            "expression_statement",
            "for_statement",
            "foreach_statement",
            "if_statement",
            "switch_statement",
            "while_statement",
          ].includes(node.type)
        ) {
          return false;
        }
        const calls = syntaxDescendants(node).filter(
          (child) => child.type === "function_call_expression",
        );
        if (calls.some((call) => callRole(file.content, call))) return false;
        return !syntaxDescendants(node).some((child) =>
          ["anonymous_function_creation_expression", "arrow_function"].includes(
            child.type,
          ),
        );
      });
      const first = setup[0];
      const last = setup.at(-1);
      if (first && last) {
        specialized = specialized.filter(
          ({ node }) =>
            !(
              node.startIndex >= first.startIndex &&
              node.endIndex <= last.endIndex
            ),
        );
        const name = namespaceName
          ? `${namespaceName} namespace setup`
          : "Module setup";
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
      return specialized;
    }
    if (language === "rust") {
      let specialized = candidates;
      for (const fields of syntaxDescendants(root).filter(
        (node) => node.type === "ordered_field_declaration_list",
      )) {
        const container = syntaxAncestors(fields).find(
          (parent) => parent.type === "struct_item",
        );
        const containerName = container
          ? ownName(file.content, container)
          : undefined;
        if (!containerName) continue;
        const types = fields
          .childrenForFieldName("type")
          .filter((child): child is SyntaxNode => Boolean(child?.isNamed));
        for (const [index, type] of types.entries()) {
          const from =
            type.previousNamedSibling?.type === "visibility_modifier"
              ? type.previousNamedSibling.startIndex
              : type.startIndex;
          const name = `${containerName}.${index}`;
          specialized.push({
            node: type,
            ownName: String(index),
            unit: makeRawRangeUnit(
              file,
              language,
              "variable",
              name,
              from,
              type.endIndex,
            ),
          });
        }
      }
      for (const error of root.namedChildren.filter(
        (node): node is SyntaxNode =>
          node !== null &&
          node.type === "ERROR" &&
          syntaxDescendants(node).some(
            (child) => child.type === "extern_modifier",
          ),
      )) {
        const statement =
          error.nextNamedSibling?.type === "expression_statement"
            ? error.nextNamedSibling
            : undefined;
        const block = statement?.namedChildren.find(
          (child): child is SyntaxNode =>
            child !== null && child.type === "block",
        );
        if (!statement || !block) continue;
        const abi = syntaxDescendants(error).find(
          (child) => child.type === "string_literal",
        );
        const name = `extern ${
          abi ? nodeText(file.content, abi).replaceAll('"', "") : "C"
        }`;
        for (const candidate of specialized) {
          if (
            candidate.node.startIndex < statement.startIndex ||
            candidate.node.endIndex > statement.endIndex
          ) {
            continue;
          }
          candidate.unit.kind =
            candidate.node.type === "function_signature_item"
              ? "method"
              : candidate.unit.kind;
          candidate.unit.name = `${name}::${candidate.ownName}`;
          candidate.unit.stableKey = stableReviewKey(
            file.path,
            candidate.unit.kind,
            `${name}::${candidate.ownName}`,
          );
        }
        specialized.push({
          node: statement,
          ownName: name,
          unit: makeRawRangeUnit(
            file,
            language,
            "class",
            name,
            error.startIndex,
            block.startIndex + 1,
          ),
        });
      }
      for (const macro of syntaxDescendants(root).filter(
        (node) => node.type === "macro_invocation",
      )) {
        const macroName = ownName(file.content, macro);
        if (!["proptest!", "quickcheck!"].includes(macroName ?? "")) continue;
        specialized = specialized.filter(
          ({ node }) =>
            !(
              node.startIndex === macro.startIndex &&
              node.endIndex === macro.endIndex
            ),
        );
        const tokenTree = macro.namedChildren.find(
          (child): child is SyntaxNode =>
            child !== null && child.type === "token_tree",
        );
        if (!tokenTree) continue;
        const children = tokenTree.namedChildren.filter(
          (child): child is SyntaxNode => child !== null,
        );
        const functionNames = children.filter(
          (child) =>
            child.type === "identifier" &&
            child.previousSibling !== null &&
            nodeText(file.content, child.previousSibling) === "fn",
        );
        for (const functionName of functionNames) {
          const index = children.findIndex(
            (child) =>
              child.startIndex === functionName.startIndex &&
              child.endIndex === functionName.endIndex,
          );
          const nextFunction = functionNames.find(
            (candidate) => candidate.startIndex > functionName.startIndex,
          );
          const body = children
            .slice(index + 1)
            .filter(
              (child) =>
                child.type === "token_tree" &&
                (!nextFunction || child.startIndex < nextFunction.startIndex),
            )
            .at(-1);
          if (!body) continue;
          const name = nodeText(file.content, functionName);
          const from =
            functionName.previousSibling?.startIndex ?? functionName.startIndex;
          const to = body.endIndex;
          specialized.push({
            node: macro,
            ownName: name,
            unit: makeRawRangeUnit(file, language, "test", name, from, to),
          });
        }
      }
      return specialized;
    }
    if (language === "kotlin") {
      const unique = new Map<string, (typeof candidates)[number]>();
      for (const candidate of candidates) {
        const key = `${candidate.unit.kind}:${candidate.unit.name}:${candidate.unit.startLine}`;
        if (!unique.has(key)) {
          unique.set(key, candidate);
        }
      }
      const specialized = [...unique.values()];
      const setup = root.namedChildren.filter((node): node is SyntaxNode => {
        if (!node) return false;
        if (
          [
            "class_declaration",
            "function_declaration",
            "import_list",
            "object_declaration",
            "package_header",
            "property_declaration",
            "type_alias",
          ].includes(node.type)
        ) {
          return false;
        }
        if (node.type === "call_expression" && callRole(file.content, node)) {
          return false;
        }
        return !shape.comments.has(node.type);
      });
      const first = setup[0];
      const last = setup.at(-1);
      if (first && last) {
        specialized.push({
          node: first,
          ownName: "Kotlin module statements",
          unit: makeRawRangeUnit(
            file,
            language,
            "module",
            "Kotlin module statements",
            first.startIndex,
            last.endIndex,
          ),
        });
      }
      return specialized;
    }
    if (language === "python") {
      let specialized = candidates;
      for (const container of syntaxDescendants(root).filter(
        (node) => node.type === "class_definition",
      )) {
        const containerName = ownName(file.content, container);
        const body = bodyNode(container, shape);
        if (!containerName || !body) continue;

        const classStatements = body.namedChildren.filter(
          (node): node is SyntaxNode =>
            node !== null &&
            ![
              "class_definition",
              "decorated_definition",
              "expression_statement",
              "function_definition",
            ].includes(node.type),
        );
        const firstStatement = classStatements[0];
        const lastStatement = classStatements.at(-1);
        if (firstStatement && lastStatement) {
          specialized = specialized.filter(
            ({ node }) =>
              !(
                node.startIndex >= firstStatement.startIndex &&
                node.endIndex <= lastStatement.endIndex
              ),
          );
          specialized.push({
            node: firstStatement,
            ownName: `${containerName} class statements`,
            unit: makeRawRangeUnit(
              file,
              language,
              "module",
              `${containerName} class statements`,
              firstStatement.startIndex,
              lastStatement.endIndex,
            ),
          });
        }

        const lifecycle = specialized
          .filter(
            ({ node, ownName }) =>
              ["setup", "setUp", "teardown", "tearDown"].includes(ownName) &&
              syntaxAncestors(node).some(
                (ancestor) =>
                  ancestor.type === container.type &&
                  ancestor.startIndex === container.startIndex &&
                  ancestor.endIndex === container.endIndex,
              ),
          )
          .sort((left, right) => left.node.startIndex - right.node.startIndex);
        const firstLifecycle = lifecycle[0];
        const lastLifecycle = lifecycle.at(-1);
        if (firstLifecycle && lastLifecycle) {
          const lifecycleNodes = new Set(lifecycle.map(({ node }) => node));
          specialized = specialized.filter(
            ({ node }) => !lifecycleNodes.has(node),
          );
          const lifecycleName = `${containerName} › Test lifecycle`;
          specialized.push({
            node: firstLifecycle.node,
            ownName: "Test lifecycle",
            unit: makeRawRangeUnit(
              file,
              language,
              "test_hook",
              lifecycleName,
              firstLifecycle.node.startIndex,
              lastLifecycle.node.endIndex,
            ),
          });
        }
      }

      if (file.path.toLowerCase().includes("test")) {
        const setup = root.namedChildren.filter(
          (node): node is SyntaxNode =>
            node !== null &&
            node.type === "expression_statement" &&
            !syntaxDescendants(node).some(
              (child) => child.type === "assignment",
            ) &&
            !node.namedChildren.every(
              (child) => child === null || child.type === "string",
            ),
        );
        const firstSetup = setup[0];
        const lastSetup = setup.at(-1);
        if (firstSetup && lastSetup) {
          specialized.push({
            node: firstSetup,
            ownName: "Test module setup",
            unit: makeRawRangeUnit(
              file,
              language,
              "module",
              "Test module setup",
              firstSetup.startIndex,
              lastSetup.endIndex,
            ),
          });
        }
      }
      return specialized;
    }
    return candidates;
  }

  return {
    declarationCandidates,
    probes: scripting.probes,
    strategies,
  };
}
