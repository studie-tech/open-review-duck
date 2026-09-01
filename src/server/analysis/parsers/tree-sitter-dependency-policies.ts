import type { Node as SyntaxNode } from "web-tree-sitter";
import {
  nodeText,
  syntaxDescendants,
  type TreeSitterLanguage,
  withSyntaxTree,
} from "../tree-sitter";
import type {
  CandidateToolkit,
  ReviewCandidate,
} from "./tree-sitter-candidate-types";
import type { LanguageShape } from "./tree-sitter-language-shapes";
import { shapes } from "./tree-sitter-language-shapes";

interface DependencyPolicyToolkit
  extends Pick<
    CandidateToolkit,
    "isCppModuleContextNode" | "isHeaderGuardDefinition" | "syntaxAncestors"
  > {
  isPhpImportNode(node: SyntaxNode): boolean;
  isReviewedType(shape: LanguageShape, type: string): boolean;
  normalizeName(value: string | undefined): string | undefined;
}

interface LanguageProbes {
  luaRequireSpec(source: string, node: SyntaxNode): string | undefined;
  luaVariableName(source: string, node: SyntaxNode): string | undefined;
  rubyCallName(source: string, node: SyntaxNode): string | undefined;
  shellSourceSpecifier(source: string, node: SyntaxNode): string | undefined;
}

/** Creates dependency and top-level-content policies for every language. */
export function createDependencyPolicies(
  toolkit: DependencyPolicyToolkit,
  probes: LanguageProbes,
) {
  const {
    isCppModuleContextNode,
    isHeaderGuardDefinition,
    isPhpImportNode,
    isReviewedType,
    normalizeName,
    syntaxAncestors,
  } = toolkit;
  const {
    luaRequireSpec,
    luaVariableName,
    rubyCallName,
    shellSourceSpecifier,
  } = probes;

  /** Connects same-file and external dependencies between raw candidates. */
  function connectDependencies(
    source: string,
    language: TreeSitterLanguage,
    candidates: ReviewCandidate[],
  ) {
    const shape = shapes[language];
    const byName = new Map<string, string[]>();
    for (const { ownName, unit } of candidates) {
      const keys = byName.get(ownName) ?? [];
      keys.push(unit.stableKey);
      byName.set(ownName, keys);
      const normalized = normalizeName(ownName);
      if (normalized && normalized !== ownName) {
        const normalizedKeys = byName.get(normalized) ?? [];
        normalizedKeys.push(unit.stableKey);
        byName.set(normalized, normalizedKeys);
      }
    }
    // Nesting is decided by comparing every declaration against every other, and
    // a node's extent and parenthood each cost a round trip into Wasm. Reading
    // them once per declaration keeps that comparison in plain JavaScript.
    const extents = candidates.map(({ node, unit }) => ({
      nested: node.parent !== null,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      stableKey: unit.stableKey,
      name: unit.name,
    }));
    for (const [position, candidate] of candidates.entries()) {
      const dependencies = new Set<string>();
      if (language === "hcl") {
        for (const variable of syntaxDescendants(candidate.node).filter(
          (node) => node.type === "variable_expr",
        )) {
          const rootName = syntaxDescendants(variable).find(
            (node) => node.type === "identifier",
          );
          if (!rootName) continue;
          const parts = [nodeText(source, rootName)];
          for (
            let sibling = variable.nextNamedSibling;
            sibling?.type === "get_attr";
            sibling = sibling.nextNamedSibling
          ) {
            const attribute = syntaxDescendants(sibling).find(
              (node) => node.type === "identifier",
            );
            if (attribute) parts.push(nodeText(source, attribute));
          }
          let address = parts.join(".");
          let target: string[] | undefined;
          while (address.includes(".")) {
            target = byName.get(address);
            if (target) break;
            address = address.slice(0, address.lastIndexOf("."));
          }
          if (target?.length === 1 && target[0] !== candidate.unit.stableKey) {
            dependencies.add(target[0] as string);
          } else if (!target) {
            const [namespace, ...rest] = parts;
            const labels: Record<string, string> = {
              data: "Data",
              local: "Local",
              module: "Module",
              output: "Output",
              var: "Variable",
            };
            if (namespace && labels[namespace] && rest.length > 0) {
              const count = namespace === "data" ? 2 : 1;
              dependencies.add(
                `${labels[namespace]} ${rest.slice(0, count).join(".")}`,
              );
            }
          }
        }
      }
      if (language === "lua") {
        let root: SyntaxNode = candidate.node;
        while (root.parent) root = root.parent;
        const imports = new Map<string, string>();
        for (const statement of root.namedChildren) {
          if (statement?.type !== "variable_declaration") continue;
          const alias = luaVariableName(source, statement);
          const specifier = luaRequireSpec(source, statement);
          if (alias && specifier)
            imports.set(alias, `lua-require:${specifier}`);
        }
        // Lua spells a use and a binding with the same node, so only identifiers
        // outside a target list or parameter list are genuine references.
        for (const variable of syntaxDescendants(candidate.node).filter(
          (node) =>
            shapes.lua.identifierTypes.has(node.type) &&
            node.parent?.type !== "variable_list" &&
            node.parent?.type !== "parameters",
        )) {
          const reference = nodeText(source, variable);
          const target = byName.get(reference);
          if (target?.length === 1 && target[0] !== candidate.unit.stableKey) {
            dependencies.add(target[0] as string);
          }
          const moduleName = reference.split(/[.:]/, 1)[0];
          const external = moduleName ? imports.get(moduleName) : undefined;
          if (external) dependencies.add(external);
        }
        if (
          candidate.unit.kind === "class" ||
          candidate.unit.name.startsWith("Module ")
        ) {
          for (const child of candidates) {
            if (
              child.unit.stableKey !== candidate.unit.stableKey &&
              (child.ownName.startsWith(`${candidate.ownName}.`) ||
                child.ownName.startsWith(`${candidate.ownName}:`))
            ) {
              dependencies.add(child.unit.stableKey);
            }
          }
        }
      }
      if (language === "makefile") {
        for (const word of syntaxDescendants(candidate.node).filter(
          (node) => node.type === "word",
        )) {
          const reference = nodeText(source, word);
          const targets = byName.get(reference);
          if (
            targets?.length === 1 &&
            targets[0] !== candidate.unit.stableKey
          ) {
            dependencies.add(targets[0] as string);
          }
        }
        for (const call of syntaxDescendants(candidate.node).filter(
          (node) => node.type === "function_call",
        )) {
          const functionName = call.children
            .filter((child): child is SyntaxNode => child !== null)
            .find((child) => child.type === "call");
          if (!functionName) continue;
          const argumentsNode = call.namedChildren.find(
            (child): child is SyntaxNode =>
              child !== null && child.type === "arguments",
          );
          const reference = argumentsNode
            ? nodeText(source, argumentsNode).split(",", 1)[0]?.trim()
            : undefined;
          const targets = reference ? byName.get(reference) : undefined;
          if (
            targets?.length === 1 &&
            targets[0] !== candidate.unit.stableKey
          ) {
            dependencies.add(targets[0] as string);
          }
        }
        for (const recipeLine of syntaxDescendants(candidate.node).filter(
          (node) => node.type === "recipe_line",
        )) {
          const makeReference = syntaxDescendants(recipeLine).find(
            (node) =>
              node.type === "variable_reference" &&
              syntaxDescendants(node).some(
                (child) =>
                  child.type === "word" && nodeText(source, child) === "MAKE",
              ),
          );
          if (!makeReference) continue;
          const commandArguments = source.slice(
            makeReference.endIndex,
            recipeLine.endIndex,
          );
          withSyntaxTree("shell", commandArguments, (tree) => {
            for (const word of syntaxDescendants(tree.rootNode).filter(
              (node) => node.type === "word",
            )) {
              const reference = nodeText(commandArguments, word);
              if (reference.startsWith("-") || reference.includes("="))
                continue;
              const targets = byName.get(reference);
              if (
                targets?.length === 1 &&
                targets[0] !== candidate.unit.stableKey
              ) {
                dependencies.add(targets[0] as string);
              }
            }
          });
        }
        const configuration = candidates.find(
          ({ ownName }) => ownName === "Build configuration",
        );
        if (
          configuration &&
          configuration.unit.stableKey !== candidate.unit.stableKey &&
          syntaxDescendants(candidate.node).some(
            (node) => node.type === "variable_reference",
          )
        ) {
          dependencies.add(configuration.unit.stableKey);
        }
      }
      if (language === "shell") {
        let root: SyntaxNode = candidate.node;
        while (root.parent) root = root.parent;
        const lineStarts = [0];
        for (let index = 0; index < source.length; index += 1) {
          if (source[index] === "\n") lineStarts.push(index + 1);
        }
        const rangeStart = lineStarts[candidate.unit.startLine - 1] ?? 0;
        const rangeEnd = lineStarts[candidate.unit.endLine] ?? source.length;
        for (const word of syntaxDescendants(root).filter(
          (node) =>
            node.type === "word" &&
            node.startIndex >= rangeStart &&
            node.endIndex <= rangeEnd,
        )) {
          const reference = nodeText(source, word);
          const targets = byName.get(reference);
          if (
            targets?.length === 1 &&
            targets[0] !== candidate.unit.stableKey
          ) {
            dependencies.add(targets[0] as string);
          }
        }
        for (const command of syntaxDescendants(root).filter(
          (node) =>
            node.type === "command" &&
            ((node.startIndex >= rangeStart && node.endIndex <= rangeEnd) ||
              node.parent?.type === "program"),
        )) {
          const specifier = shellSourceSpecifier(source, command);
          if (specifier) dependencies.add(`shell-source:${specifier}`);
        }
      }
      if (language !== "makefile" && language !== "shell") {
        for (const descendant of syntaxDescendants(candidate.node)) {
          const phpAttributeString =
            language === "php" &&
            descendant.type === "string_content" &&
            syntaxAncestors(descendant).some(
              (parent) => parent.type === "attribute",
            );
          if (
            !shape.identifierTypes.has(descendant.type) &&
            !phpAttributeString
          ) {
            continue;
          }
          const rawReference = nodeText(source, descendant);
          const reference = normalizeName(
            language === "rust" && rawReference.includes("::")
              ? rawReference.split("::").at(-1)
              : rawReference,
          );
          if (!reference || reference === candidate.ownName) continue;
          const targets = byName.get(reference);
          if (
            targets?.length === 1 &&
            targets[0] !== candidate.unit.stableKey
          ) {
            dependencies.add(targets[0] as string);
          } else if (!targets) {
            dependencies.add(`${candidate.unit.path}:${reference}`);
          }
        }
      }
      const extent = extents[position] ?? {
        startIndex: candidate.node.startIndex,
        endIndex: candidate.node.endIndex,
      };
      for (const child of extents) {
        if (
          child.nested &&
          child.startIndex >= extent.startIndex &&
          child.endIndex <= extent.endIndex &&
          child.stableKey !== candidate.unit.stableKey
        ) {
          dependencies.add(child.stableKey);
        }
        if (
          language === "go" &&
          candidate.unit.kind === "class" &&
          child.name.startsWith(`${candidate.ownName}.`) &&
          child.stableKey !== candidate.unit.stableKey
        ) {
          dependencies.add(child.stableKey);
        }
      }
      candidate.unit.dependencies = [...dependencies];
    }
    return candidates.map(({ unit }) => unit);
  }

  /** Returns top-level syntax that represents reviewable, non-context content. */
  function meaningfulNodes(
    language: TreeSitterLanguage,
    root: SyntaxNode,
    source: string,
  ) {
    const shape = shapes[language];
    return root.namedChildren.filter((node): node is SyntaxNode => {
      if (!node) return false;
      if (shape.comments.has(node.type) || shape.imports.has(node.type))
        return false;
      if (
        (language === "javascript" ||
          language === "typescript" ||
          language === "python") &&
        node.type === "expression_statement" &&
        node.namedChildren.every(
          (child) => child === null || child.type === "string",
        )
      ) {
        return false;
      }
      if (language === "ruby" && node.type === "call") {
        const name = rubyCallName(source, node)?.toLowerCase();
        if (
          !node.childForFieldName("receiver") &&
          ["autoload", "load", "require", "require_relative"].includes(
            name ?? "",
          )
        ) {
          return false;
        }
      }
      if (
        language === "lua" &&
        (node.type === "variable_declaration" || node.type === "function_call")
      ) {
        return luaRequireSpec(source, node) === undefined;
      }
      if (language === "shell" && node.type === "command") {
        return shellSourceSpecifier(source, node) === undefined;
      }
      if (language === "csharp" && node.type === "namespace_declaration") {
        return syntaxDescendants(node).some(
          (descendant) =>
            shapes.csharp.containers.has(descendant.type) ||
            shapes.csharp.functions.has(descendant.type) ||
            shapes.csharp.variables.has(descendant.type) ||
            descendant.type === "global_statement",
        );
      }
      if (
        (language === "c" || language === "cpp") &&
        ["preproc_if", "preproc_ifdef"].includes(node.type)
      ) {
        return syntaxDescendants(node).some(
          (descendant) =>
            isReviewedType(shape, descendant.type) &&
            !isHeaderGuardDefinition(source, descendant),
        );
      }
      if (language === "cpp" && isCppModuleContextNode(source, node)) {
        return false;
      }
      if (language === "php" && isPhpImportNode(node)) return false;
      if (language === "rust" && node.type === "mod_item") {
        return Boolean(node.childForFieldName("body"));
      }
      if (language === "php" && node.type === "namespace_definition") {
        const body = node.childForFieldName("body");
        if (!body) return false;
        return body.namedChildren.some(
          (child) =>
            child !== null &&
            !shape.comments.has(child.type) &&
            !isPhpImportNode(child) &&
            nodeText(source, child).trim().length > 0,
        );
      }
      return nodeText(source, node).trim().length > 0;
    });
  }

  return { connectDependencies, meaningfulNodes };
}
