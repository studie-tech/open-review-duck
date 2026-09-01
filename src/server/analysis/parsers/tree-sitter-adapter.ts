import type { Node as SyntaxNode } from "web-tree-sitter";
import { semanticSource, sha256, stableReviewKey } from "../hash";
import {
  nodeText,
  syntaxDescendants,
  type TreeSitterLanguage,
  withSyntaxTree,
} from "../tree-sitter";
import {
  type LanguageAdapter,
  type RawUnit,
  type SourceFile,
  supportedExtensions,
  supportedFileNames,
  type UnitKind,
} from "../types";
import { createCandidateExtractor } from "./tree-sitter-candidate-strategies";
import { createDependencyPolicies } from "./tree-sitter-dependency-policies";
import {
  commonIdentifiers,
  type LanguageShape,
  shapes,
} from "./tree-sitter-language-shapes";

export interface SemanticSymbolOccurrence {
  name: string;
  role: "definition" | "reference";
  startLine: number;
  endLine: number;
  scopeChain: string[];
}

/** Creates an immutable-by-convention syntax-node type set. */
const set = (...values: string[]) => new Set(values);

const assignmentTypes = new Set([
  "assignment",
  "assignment_statement",
  "expression_statement",
  "lexical_declaration",
  "variable_declaration",
  "declaration",
]);

const functionBoundaryTypes = new Set([
  "arrow_function",
  "function_expression",
  "function_definition",
  "function_declaration",
  "generator_function_declaration",
  "lambda",
  "method_definition",
]);

const testCalls = new Set([
  "context",
  "description",
  "describe",
  "feature",
  "it",
  "scenario",
  "specify",
  "test",
  "testcase",
]);

const hookCalls = new Set([
  "after",
  "after_all",
  "after_each",
  "afterall",
  "aftereach",
  "before",
  "before_all",
  "before_each",
  "beforeall",
  "beforeeach",
  "beforetest",
  "dataset",
  "setup",
  "setup_all",
  "teardown",
  "aftertest",
]);

const MAXIMUM_INDEXED_SOURCES = 4;
const lineStartIndexes = new Map<string, Int32Array>();

/**
 * Indexes where every line of one source begins.
 *
 * Each declaration asks for the line of its first and last offset, so a file's
 * offsets are converted as many times as it holds declarations. The index is a
 * pure function of the text, and analysis walks one revision of one file at a
 * time, so retaining the few most recent ones converts the whole file once.
 */
function lineStartOffsets(source: string) {
  const indexed = lineStartIndexes.get(source);
  if (indexed) return indexed;
  const starts = [0];
  for (
    let index = source.indexOf("\n");
    index !== -1;
    index = source.indexOf("\n", index + 1)
  ) {
    starts.push(index + 1);
  }
  const offsets = Int32Array.from(starts);
  const oldest = lineStartIndexes.keys().next().value;
  if (
    lineStartIndexes.size >= MAXIMUM_INDEXED_SOURCES &&
    oldest !== undefined
  ) {
    lineStartIndexes.delete(oldest);
  }
  lineStartIndexes.set(source, offsets);
  return offsets;
}

/** Returns the one-based source line containing an offset. */
function lineAt(source: string, offset: number) {
  const offsets = lineStartOffsets(source);
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((offsets[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Grammar fields that label the child naming a declaration, most specific
 * first. `key` covers mapping entries, `method` covers members written as
 * `owner.member`, `as`/`alias` cover `<subject> AS <alias>` headers such as a
 * Dockerfile build stage, and `text` covers markup sectioning commands whose
 * title is the argument group they take.
 */
const nameFields = [
  "name",
  "declarator",
  "key",
  "method",
  "alias",
  "as",
  "text",
  "left",
  "target",
];

/** Node types that bind a name to a value and so carry the name themselves. */
const declaratorTypes = [
  "assignment",
  "const_spec",
  "init_declarator",
  "variable_declarator",
  "variable_declaration",
];

/**
 * Reports whether a node type follows one of Tree-sitter's identifier-token
 * naming conventions: a member of the shared identifier set, an `ident` token,
 * or any `*_name` / `*_identifier` / `*_key` node.
 */
function isIdentifierNodeType(type: string) {
  return (
    commonIdentifiers.has(type) ||
    type === "ident" ||
    type.endsWith("_name") ||
    type.endsWith("_identifier") ||
    type.endsWith("_key")
  );
}

/** Reports whether an identifier node spells a type rather than a declared name. */
function isTypeAnnotationNodeType(type: string) {
  return isIdentifierNodeType(type) && type.includes("type");
}

/**
 * Reports whether a node points at a declaration made elsewhere. Grammars name
 * these nodes `*reference*`, so the identifier inside one is the subject a
 * statement acts on (the table an `ALTER TABLE` mutates), never its own name.
 */
function isReferenceNodeType(type: string) {
  return type.includes("reference");
}

/** Reports whether a node reaches a member through its owner, as in `a.b`. */
function isMemberAccessNodeType(type: string) {
  return type.includes("access");
}

/** Reports whether a child ends a declaration's header and opens its body. */
function isBodyChild(child: SyntaxNode, field: string | null) {
  if (field === "body" || field === "block") return true;
  if (!child.isNamed) return child.type === "{";
  return (
    child.type === "block" ||
    child.type === "body" ||
    child.type.endsWith("_block") ||
    child.type.endsWith("_body")
  );
}

/**
 * Returns the children forming a declaration's header — everything up to the
 * body it introduces. A declaration never names itself inside its own body, so
 * this keeps name lookup from reaching into member and statement lists.
 */
function declarationHeaderChildren(node: SyntaxNode) {
  const header: SyntaxNode[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child) continue;
    if (isBodyChild(child, node.fieldNameForChild(index))) break;
    // A markup tag or a heading is a complete header on its own; whatever
    // follows is the content it introduces, not more of the declaration.
    const previous = header.at(-1)?.type;
    if (previous?.endsWith("_tag") || previous?.endsWith("_heading")) break;
    header.push(child);
  }
  return header;
}

/** Returns the child a grammar field marks as the declaration's name. */
function fieldNameChild(node: SyntaxNode) {
  for (const field of nameFields) {
    const direct = node.childForFieldName(field);
    if (direct) return direct;
  }
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child && node.fieldNameForChild(index)?.endsWith("_name")) return child;
  }
  return undefined;
}

interface NameMatch {
  node: SyntaxNode;
  /**
   * Whether the grammar itself singled this identifier out — through a field, a
   * declarator chain, or a qualified name's final segment — rather than it just
   * being the first identifier the search happened to reach.
   */
  labelled: boolean;
}

/**
 * Reports whether an identifier the grammar never labelled opens the subtree it
 * was found in. Only keywords and whitespace may precede it: once punctuation
 * intervenes, that subtree is a compound construct — a CSS selector, a media
 * feature query — whose leading identifier is one fragment of it, not a name.
 */
function opensSubtree(source: string, child: SyntaxNode, match: NameMatch) {
  return (
    match.labelled ||
    !/[^\w\s]/.test(source.slice(child.startIndex, match.node.startIndex))
  );
}

/** Searches a header's children for a name the grammar left unlabelled. */
function nestedNameMatch(
  source: string,
  header: SyntaxNode[],
  allowTypeAnnotation: boolean,
) {
  for (const child of header) {
    if (isTypeAnnotationNodeType(child.type)) continue;
    const nested = declarationNameMatch(source, child, allowTypeAnnotation);
    if (nested && opensSubtree(source, child, nested)) return nested;
  }
  return undefined;
}

/**
 * Locates the identifier a declaration declares, and how the grammar marked it.
 * Grammars spell a Kotlin class name and a Dart field's type with the same
 * `type_identifier` node, so a type annotation names the declaration only once
 * every other candidate is exhausted: any non-type name beats it, a directly
 * annotated header beats a nested one, and a nested annotation is taken only
 * when the caller still allows one.
 */
function declarationNameMatch(
  source: string,
  node: SyntaxNode,
  allowTypeAnnotation = true,
): NameMatch | undefined {
  const labelledChild =
    fieldNameChild(node) ??
    node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && declaratorTypes.includes(child.type),
    ) ??
    node.namedChildren.find((child): child is SyntaxNode =>
      Boolean(child?.type.includes("declarator")),
    );
  if (labelledChild) {
    return {
      node: declarationNameMatch(source, labelledChild)?.node ?? labelledChild,
      labelled: true,
    };
  }
  const header = declarationHeaderChildren(node).filter(
    (child) => child.isNamed && !isReferenceNodeType(child.type),
  );
  // In a member access the leading segments name the owner and the last names
  // the member, so `$this.Id` declares `Id`. Only grammars that call the node
  // an access qualify: a `::` elsewhere may ascribe a type instead.
  const accessed = isMemberAccessNodeType(node.type)
    ? [...header].reverse().find((child) => isIdentifierNodeType(child.type))
    : undefined;
  if (accessed) {
    return {
      node: declarationNameMatch(source, accessed)?.node ?? accessed,
      labelled: true,
    };
  }
  const declared = header.find(
    (child) =>
      isIdentifierNodeType(child.type) && !isTypeAnnotationNodeType(child.type),
  );
  if (declared) {
    return {
      node: declarationNameMatch(source, declared)?.node ?? declared,
      labelled: false,
    };
  }
  const nested = nestedNameMatch(source, header, false);
  if (nested) return nested;
  if (!allowTypeAnnotation) return undefined;
  const annotated = header.find((child) => isIdentifierNodeType(child.type));
  if (annotated) {
    return {
      node: declarationNameMatch(source, annotated)?.node ?? annotated,
      labelled: false,
    };
  }
  return nestedNameMatch(source, header, true);
}

/** Locates the syntax node that owns a declaration's name. */
function declarationNameNode(source: string, node: SyntaxNode) {
  return declarationNameMatch(source, node)?.node;
}

const MAXIMUM_HEADER_NAME_LENGTH = 72;

/**
 * Titles a declaration the grammar exposes no identifier for with its own
 * header text, so instructions and rules that share a leading keyword — every
 * `COPY`, every `ALTER TABLE`, every CSS selector — stay tellable apart. A
 * header holding nothing but keywords and punctuation names nothing, and the
 * declaration is left anonymous rather than titled after its keyword.
 */
function declarationHeaderText(source: string, node: SyntaxNode) {
  const header = declarationHeaderChildren(node);
  if (!header.some((child) => child.isNamed)) return undefined;
  const text = source
    .slice(node.startIndex, header.at(-1)?.endIndex ?? node.endIndex)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAXIMUM_HEADER_NAME_LENGTH
    ? `${text.slice(0, MAXIMUM_HEADER_NAME_LENGTH - 1).trimEnd()}…`
    : text;
}

/**
 * Normalizes a declaration token for same-file dependency matching.
 *
 * Operator suffixes belong to names such as Ruby's `fetch!` or `<=>`. A bracket
 * never does: a name matched here always begins with a word character, so a
 * bracket can only trail one, where it closes the enclosing table or index.
 */
function normalizeName(value: string | undefined) {
  return value
    ?.trim()
    .replace(/^[$@]+/, "")
    .match(/[A-Za-z_][\w$!?=<>+\-*/%]*/)?.[0];
}

/** Extracts the semantic name owned by a declaration node. */
function ownName(source: string, node: SyntaxNode) {
  if (node.type.startsWith("create_")) {
    const name =
      /^\s*create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:materialized\s+view|table|view|index|schema|type|function|procedure|trigger|policy|sequence)\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([^\s(;]+)/i.exec(
        nodeText(source, node),
      )?.[1];
    if (name) return name.replace(/^(?:["'`]|\[)|(?:["'`]|\])$/g, "");
  }
  if (node.type === "companion_object") return "Companion";
  if (node.type === "anonymous_initializer") return "init";
  if (node.type === "ordered_field_declaration") {
    const siblings = node.parent?.namedChildren.filter(
      (child): child is SyntaxNode =>
        child !== null && child.type === "ordered_field_declaration",
    );
    const index = siblings?.findIndex(
      (sibling) =>
        sibling.startIndex === node.startIndex &&
        sibling.endIndex === node.endIndex,
    );
    if (index !== undefined && index >= 0) return String(index);
  }
  if (node.type === "impl_item") {
    const trait = node.childForFieldName("trait");
    const type = node.childForFieldName("type");
    if (trait && type) {
      return `impl ${nodeText(source, trait)} for ${nodeText(source, type)}`;
    }
    if (type) return `impl ${nodeText(source, type)}`;
  }
  if (node.type === "foreign_mod_item") {
    const abi = syntaxDescendants(node).find((child) =>
      child.type.includes("string"),
    );
    return `extern ${abi ? nodeText(source, abi).replaceAll('"', "") : "C"}`;
  }
  if (node.type === "macro_invocation") {
    const macro =
      node.childForFieldName("macro") ??
      node.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null &&
          ["identifier", "scoped_identifier"].includes(child.type),
      );
    if (macro) return `${nodeText(source, macro)}!`;
  }
  if (
    node.type === "property_declaration" ||
    node.type === "property_promotion_parameter"
  ) {
    const variable = syntaxDescendants(node).find(
      (child) => child.type === "variable_name",
    );
    if (variable) return nodeText(source, variable);
  }
  if (node.type === "const_declaration") {
    const element = syntaxDescendants(node).find(
      (child) => child.type === "const_element",
    );
    const name = element?.namedChildren.find(
      (child): child is SyntaxNode => child !== null && child.type === "name",
    );
    if (name) return nodeText(source, name);
  }
  if (node.type === "const_spec" || node.type === "var_spec") {
    const names = node
      .childrenForFieldName("name")
      .filter((child): child is SyntaxNode => Boolean(child?.isNamed))
      .map((child) => nodeText(source, child));
    if (names.length > 0) return names.join(", ");
  }
  if (node.type === "block") {
    const labels = node.namedChildren
      .filter(
        (child): child is SyntaxNode =>
          child !== null &&
          (child.type === "identifier" || child.type.includes("literal")),
      )
      .map((child) => nodeText(source, child).replace(/^["']|["']$/g, ""));
    if (labels.length > 0) return labels.join(".");
  }
  if (node.type === "rule") {
    return normalizeName(nodeText(source, node).split(":", 1)[0]);
  }
  const nameNode = declarationNameNode(source, node);
  const fieldName = normalizeName(
    nameNode ? nodeText(source, nameNode) : undefined,
  );
  if (fieldName) return fieldName;
  if (node.namedChildCount === 0) return normalizeName(nodeText(source, node));
  return declarationHeaderText(source, node);
}

/** Extracts C++ names, including operators and test-framework cases. */
function cppDeclarationName(source: string, node: SyntaxNode) {
  if (shapes.cpp.containers.has(node.type)) return ownName(source, node);
  const text = nodeText(source, node);
  // GoogleTest case macros identify a test with the same suite and case
  // arguments across plain, fixture, parameterized, and typed forms.
  const testCaseName =
    /\b(?:TYPED_)?TEST(?:_[FP])?\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(
      text,
    );
  if (testCaseName?.[1] && testCaseName[2]) {
    return `${testCaseName[1]} › ${testCaseName[2]}`;
  }
  const testCase = /\bTEST_CASE\s*\(\s*"([^"]+)"/.exec(text)?.[1];
  if (testCase) return testCase;
  const destructor = /(~[A-Za-z_]\w*)\s*\(/.exec(text)?.[1];
  if (destructor) return destructor;
  const operator = /\boperator\s*(\(\)|\[\]|[^\s(]+)/.exec(text)?.[1];
  if (operator) return `operator${operator}`;
  return ownName(source, node);
}

/** Returns the named declaration containers surrounding a node. */
function enclosingContainer(
  source: string,
  node: SyntaxNode,
  shape: LanguageShape,
) {
  const scopes: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (shape.containers.has(parent.type)) {
      const name = ownName(source, parent);
      if (name) scopes.unshift(name);
    }
  }
  return scopes;
}

/** Returns language-aware scopes used to qualify a declaration. */
function declarationScopes(
  language: TreeSitterLanguage,
  source: string,
  node: SyntaxNode,
  shape: LanguageShape,
) {
  if (language === "go" && node.type === "method_declaration") {
    const receiver = node.childForFieldName("receiver");
    const receiverType = receiver
      ? syntaxDescendants(receiver).find(
          (child) => child.type === "type_identifier",
        )
      : undefined;
    if (receiverType) return [nodeText(source, receiverType)];
  }
  if (language === "go" && node.type === "short_var_declaration") {
    const owner = syntaxAncestors(node).find((parent) =>
      shapes.go.functions.has(parent.type),
    );
    const name = owner ? ownName(source, owner) : undefined;
    if (name) return [name];
  }
  if (language === "c") {
    const typeDefinition = syntaxAncestors(node).find(
      (parent) => parent.type === "type_definition",
    );
    const name = typeDefinition ? ownName(source, typeDefinition) : undefined;
    if (name) return [name];
  }
  if (language === "cpp") {
    const scopes: string[] = [];
    for (const parent of syntaxAncestors(node).reverse()) {
      if (parent.type === "namespace_definition") {
        const nameNode = parent.childForFieldName("name");
        if (nameNode) scopes.push(...nodeText(source, nameNode).split("::"));
      } else if (shape.containers.has(parent.type)) {
        const name = ownName(source, parent);
        if (name) scopes.push(name);
      }
    }
    return scopes;
  }
  if (language === "php") {
    for (const parent of syntaxAncestors(node)) {
      if (parent.type !== "function_call_expression") continue;
      const role = callRole(source, parent);
      if (role?.kind === "test_suite") return [role.name];
    }
  }
  if (language === "rust") {
    const scopes: string[] = [];
    for (const parent of syntaxAncestors(node).reverse()) {
      if (
        [
          "enum_item",
          "foreign_mod_item",
          "impl_item",
          "mod_item",
          "struct_item",
          "trait_item",
          "union_item",
        ].includes(parent.type)
      ) {
        const name = ownName(source, parent);
        if (name) scopes.push(name);
      }
    }
    if (node.type === "let_declaration") {
      const owner = syntaxAncestors(node).find(
        (parent) => parent.type === "function_item",
      );
      const name = owner ? ownName(source, owner) : undefined;
      if (name) scopes.push(name);
    }
    return scopes;
  }
  if (language === "python" && node.type === "call") {
    const scopes = syntaxAncestors(node)
      .filter((parent) => parent.type === "with_statement")
      .map((parent) => {
        const call = syntaxDescendants(parent).find(
          (child) =>
            child.type === "call" &&
            child.startIndex <
              (parent.childForFieldName("body")?.startIndex ?? parent.endIndex),
        );
        return call ? callRole(source, call) : undefined;
      })
      .filter(
        (role): role is { kind: "test_suite"; name: string } =>
          role?.kind === "test_suite",
      )
      .reverse()
      .map(({ name }) => name);
    return scopes;
  }
  if (language === "kotlin") {
    const scopes = enclosingContainer(source, node, shape);
    if (node.type === "function_declaration") {
      const receiver = node.namedChildren.find(
        (child): child is SyntaxNode =>
          child !== null && child.type === "user_type",
      );
      if (
        receiver &&
        receiver.startIndex <
          (declarationNameNode(source, node)?.startIndex ?? node.endIndex)
      ) {
        return [...scopes, nodeText(source, receiver)];
      }
    }
    const suites = syntaxAncestors(node)
      .filter((parent) => parent.type === "call_expression")
      .map((parent) => callRole(source, parent))
      .filter(
        (role): role is { kind: "test_suite"; name: string } =>
          role?.kind === "test_suite",
      )
      .reverse()
      .map(({ name }) => name);
    return [...scopes, ...suites];
  }
  return enclosingContainer(source, node, shape);
}

/** Finds the declaration that logically owns a nested callable. */
function logicalOwnerName(source: string, node: SyntaxNode) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      [
        "lexical_declaration",
        "variable_declaration",
        "variable_declarator",
      ].includes(parent.type)
    ) {
      const name = ownName(source, parent);
      if (name) return name;
    }
    if (shapes.typescript.functions.has(parent.type)) {
      const name = ownName(source, parent);
      if (name) return name;
    }
  }
  return undefined;
}

/** Reports whether a language shape reviews a node type as a unit of its own. */
function isReviewedType(shape: LanguageShape, type: string) {
  return (
    shape.containers.has(type) ||
    shape.functions.has(type) ||
    shape.variables.has(type) ||
    Boolean(shape.moduleUnits?.has(type))
  );
}

const decoratorTypePattern =
  /(?:^|_)(?:annotation|attribute|decorator)s?(?:_|$)/;

/**
 * Reports whether a sibling node annotates the declaration that follows it.
 *
 * Grammars spell decorators differently — `annotation` in Dart, Java, and
 * Kotlin, `decorator` in TypeScript, `attribute_item` or `attribute_list`
 * elsewhere — but they all park them next to the declaration they belong to.
 * Types the shape already reviews are excluded so that a declaration such as a
 * Java `annotation_type_declaration` keeps its own review card.
 */
function isDecoratorNode(shape: LanguageShape, node: SyntaxNode) {
  return (
    decoratorTypePattern.test(node.type) && !isReviewedType(shape, node.type)
  );
}

/** Includes contiguous documentation syntax preceding a declaration. */
function leadingDocumentationStart(
  source: string,
  node: SyntaxNode,
  shape: LanguageShape,
  language?: TreeSitterLanguage,
) {
  const wrapper = declarationWrapper(node);
  let start = wrapper.startIndex;
  let sibling = wrapper.previousNamedSibling;
  while (
    sibling &&
    (shape.comments.has(sibling.type) || isDecoratorNode(shape, sibling)) &&
    source.slice(sibling.endIndex, start).trim() === ""
  ) {
    const text = nodeText(source, sibling).trim();
    const documentation =
      isDecoratorNode(shape, sibling) ||
      language === "clojure" ||
      language === "go" ||
      language === "hcl" ||
      language === "lua" ||
      language === "makefile" ||
      language === "ruby" ||
      language === "python" ||
      text.startsWith("/**") ||
      text.startsWith("///") ||
      text.startsWith("//!") ||
      text.startsWith("##");
    if (!documentation) break;
    start = sibling.startIndex;
    sibling = sibling.previousNamedSibling;
  }
  if (language === "kotlin") {
    const root = syntaxAncestors(node).at(-1);
    const comment = root
      ? syntaxDescendants(root)
          .filter(
            (candidate) =>
              shape.comments.has(candidate.type) &&
              candidate.endIndex <= start &&
              nodeText(source, candidate).trimStart().startsWith("/**"),
          )
          .at(-1)
      : undefined;
    if (comment && source.slice(comment.endIndex, start).trim() === "") {
      start = comment.startIndex;
    }
  }
  return start;
}

/** Locates the body node for a declaration shape. */
function bodyNode(node: SyntaxNode, shape: LanguageShape) {
  return (
    node.childForFieldName("body") ??
    node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && shape.bodyTypes.has(child.type),
    ) ??
    syntaxDescendants(node).find((child) => shape.bodyTypes.has(child.type))
  );
}

/**
 * Finds an implementation body that a grammar emits as a sibling of the
 * declaration it belongs to instead of nesting it inside the declaration.
 *
 * Dart is the clearest case: `class_body` holds a `method_signature` and its
 * `function_body` as consecutive children, so the declaration node stops at the
 * signature. Absorbing the sibling is only safe when the declaration truly owns
 * no body of its own and the sibling is not something the shape reviews
 * separately, which keeps constructs such as a Java field followed by an
 * instance-initializer block on their own review cards.
 */
function trailingBodySibling(
  source: string,
  node: SyntaxNode,
  shape: LanguageShape,
) {
  if (bodyNode(node, shape)) return undefined;
  const sibling = node.nextNamedSibling;
  if (
    !sibling ||
    !shape.bodyTypes.has(sibling.type) ||
    isReviewedType(shape, sibling.type) ||
    source.slice(node.endIndex, sibling.startIndex).trim() !== ""
  ) {
    return undefined;
  }
  return sibling;
}

/** Chooses the review range end for a declaration or declaration shell. */
function declarationEnd(
  source: string,
  node: SyntaxNode,
  shape: LanguageShape,
  shell: boolean,
) {
  if (!shell) return node.endIndex;
  const body = bodyNode(node, shape);
  if (!body) return node.endIndex;
  if (body.type === "block" && node.type === "class_definition") {
    const first = body.namedChildren[0];
    if (
      first?.type === "expression_statement" &&
      first.namedChildren.every(
        (child) => child === null || child.type === "string",
      )
    ) {
      return first.endIndex;
    }
    const newline = source.lastIndexOf("\n", body.startIndex - 1);
    const bodyLineStart = newline < 0 ? 0 : newline + 1;
    return Math.max(node.startIndex, bodyLineStart - 1);
  }
  return Math.min(node.endIndex, body.startIndex + 1);
}

/** Returns a declaration wrapper that carries modifiers or decorators. */
function declarationWrapper(node: SyntaxNode) {
  const parent = node.parent;
  if (!parent) return node;
  if (
    [
      "decorated_definition",
      "export_statement",
      "template_declaration",
    ].includes(parent.type)
  ) {
    return parent;
  }
  if (
    parent.type === "type_declaration" &&
    parent.namedChildren.filter(Boolean).length === 1
  ) {
    return parent;
  }
  return node;
}

/** Collects annotations and modifiers associated with a declaration. */
function annotationText(
  source: string,
  language: TreeSitterLanguage,
  node: SyntaxNode,
) {
  const start = leadingDocumentationStart(source, node, {
    ...shapes[language],
    comments: set(
      "comment",
      "line_comment",
      "block_comment",
      "multiline_comment",
    ),
  });
  return source.slice(start, Math.min(node.endIndex, node.startIndex + 500));
}

/** Classifies declaration-based tests, suites, and lifecycle hooks. */
function testRole(
  file: SourceFile,
  language: TreeSitterLanguage,
  node: SyntaxNode,
  name: string,
  source: string,
): UnitKind | undefined {
  const lower = name.toLowerCase();
  const prefix = annotationText(source, language, node).toLowerCase();
  if (shapeForTestSuite(language, node, name, prefix, file.path)) {
    return "test_suite";
  }
  if (
    /(?:@(?:[\w.]+\.)?test\b|#\[test\]|#\[tokio::test\b|#\[rstest\b|#\[quickcheck\b|@parameterizedtest\b)/.test(
      prefix,
    ) ||
    (language === "csharp" &&
      /\[(?:fact|theory|test|testcase|testmethod|datatestmethod)\b/.test(
        prefix,
      )) ||
    (!shapes[language].containers.has(node.type) &&
      /^(?:test|it_|spec_|should_|benchmark|bench_|fuzz|example)/.test(
        lower,
      )) ||
    (language === "go" &&
      /^(?:test|benchmark|fuzz|example)[A-Z_]/.test(name)) ||
    (language === "c" &&
      file.path.toLowerCase().includes("test") &&
      (/^check_/.test(lower) || name.includes(" › "))) ||
    (language === "cpp" &&
      file.path.toLowerCase().includes("test") &&
      (name.includes(" › ") ||
        /\bTEST_CASE\s*\(/.test(nodeText(source, node)))) ||
    (file.path.toLowerCase().includes("test") &&
      /^(?:test|it|should)/.test(lower))
  ) {
    return "test";
  }
  if (
    /(?:@before|@after|@setup|@teardown|#\[fixture\])/.test(prefix) ||
    (language === "csharp" &&
      (/\[(?:setup|teardown|onetimesetup|onetimeteardown|testinitialize|testcleanup)\b/.test(
        prefix,
      ) ||
        ((node.type.includes("constructor") || lower === "dispose") &&
          file.path.toLowerCase().includes("test")))) ||
    (language === "python" && /@pytest\.fixture\b/.test(prefix)) ||
    (language === "php" &&
      file.path.toLowerCase().includes("test") &&
      /^(?:invalid|provide)/i.test(name)) ||
    (language === "go" &&
      ([
        "setupsuite",
        "setupsubtest",
        "setuptest",
        "teardownsuite",
        "teardownsubtest",
        "teardowntest",
      ].includes(lower) ||
        (file.path.toLowerCase().includes("test") &&
          /^setup[A-Z_]/.test(name)))) ||
    (language === "cpp" &&
      /^(?:setup|teardown)$/.test(lower) &&
      syntaxAncestors(node).some(
        (parent) =>
          parent.type === "class_specifier" &&
          /\btesting::Test\b/.test(nodeText(source, parent)),
      )) ||
    (language !== "cpp" &&
      language !== "python" &&
      /^(?:setup|setup_class|setup_method|teardown|teardown_class|teardown_method|beforeall|beforeeach|afterall|aftereach|set_up|tear_down)$/.test(
        lower,
      )) ||
    (language === "python" &&
      /^(?:setup|setup_class|setup_method|teardown|teardown_class|teardown_method|set_up|tear_down)$/.test(
        lower,
      ) &&
      (file.path.toLowerCase().includes("test") ||
        syntaxAncestors(node).some((ancestor) => {
          if (ancestor.type !== "class_definition") return false;
          const className = ownName(source, ancestor) ?? "";
          const superclasses = ancestor.childForFieldName("superclasses");
          return (
            /^test/i.test(className) ||
            (superclasses &&
              /\b(?:TestCase|IsolatedAsyncioTestCase)\b/.test(
                nodeText(source, superclasses),
              ))
          );
        })))
  ) {
    return "test_hook";
  }
  return undefined;
}

/** Determines whether a container represents a test suite. */
function shapeForTestSuite(
  language: TreeSitterLanguage,
  node: SyntaxNode,
  name: string,
  annotation: string,
  path: string,
) {
  if (!shapes[language].containers.has(node.type)) return false;
  return (
    /(?:^|[^a-z])(?:testfixture|testsuite|runwith)\b/.test(annotation) ||
    (language === "python" &&
      path.toLowerCase().includes("test") &&
      /^test/i.test(name)) ||
    /(?:tests?|specs?)$/i.test(name)
  );
}

/** Classifies call-based test DSL constructs. */
function callRole(source: string, node: SyntaxNode) {
  const callee =
    node.childForFieldName("function") ??
    node.childForFieldName("name") ??
    node.namedChildren.find((child): child is SyntaxNode => child !== null);
  const calleeName = normalizeName(
    callee ? nodeText(source, callee) : undefined,
  );
  if (!calleeName) return undefined;
  const normalized = calleeName.toLowerCase();
  const kind = testCalls.has(normalized)
    ? normalized === "describe" ||
      normalized === "description" ||
      normalized === "context" ||
      normalized === "feature"
      ? ("test_suite" as const)
      : ("test" as const)
    : hookCalls.has(normalized)
      ? ("test_hook" as const)
      : undefined;
  if (!kind) return undefined;
  const labelNode = syntaxDescendants(node).find((child) =>
    ["string", "string_content", "interpreted_string_literal"].includes(
      child.type,
    ),
  );
  const label = labelNode
    ? nodeText(source, labelNode)
        .replace(/^["'`]|["'`]$/g, "")
        .trim()
    : calleeName;
  return { kind, name: label || calleeName };
}

/** Maps a declaration node to its review-unit kind. */
function candidateKind(
  language: TreeSitterLanguage,
  node: SyntaxNode,
  shape: LanguageShape,
  source: string,
): UnitKind | undefined {
  if (
    language === "rust" &&
    node.type === "mod_item" &&
    !node.childForFieldName("body")
  ) {
    return undefined;
  }
  if (language === "rust" && node.type === "macro_definition") {
    return "function";
  }
  if (language === "rust" && node.type === "macro_invocation") {
    return "module";
  }
  if (
    language === "cpp" &&
    ["alias_declaration", "concept_definition"].includes(node.type)
  ) {
    return "variable";
  }
  if (
    (language === "c" || language === "cpp") &&
    node.type === "type_definition" &&
    (() => {
      const declarator = node.childForFieldName("declarator");
      return (
        declarator?.type.includes("function_declarator") ||
        (declarator
          ? syntaxDescendants(declarator).some((child) =>
              child.type.includes("function_declarator"),
            )
          : false)
      );
    })()
  ) {
    return "variable";
  }
  if (shape.containers.has(node.type)) return "class";
  if (shape.functions.has(node.type)) {
    if (language === "csharp" && node.type === "delegate_declaration") {
      return "class";
    }
    if (language === "go" && node.type === "method_declaration") {
      return "method";
    }
    if (language === "rust") {
      return syntaxAncestors(node).some((parent) =>
        ["foreign_mod_item", "impl_item", "trait_item"].includes(parent.type),
      )
        ? "method"
        : "function";
    }
    return enclosingContainer(source, node, shape).length > 0
      ? "method"
      : "function";
  }
  if (shape.variables.has(node.type)) {
    const declaration = nodeText(source, node);
    if (
      language === "r" &&
      node.type === "binary_operator" &&
      syntaxDescendants(node).some(
        (child) => child.type === "function_definition",
      )
    ) {
      return "function";
    }
    if (
      language === "kotlin" &&
      node.type === "class_parameter" &&
      !syntaxDescendants(node).some(
        (child) =>
          child.type === "binding_pattern_kind" &&
          ["val", "var"].includes(nodeText(source, child)),
      )
    ) {
      return undefined;
    }
    if (language === "kotlin" && node.type === "enum_entry") {
      return "constant";
    }
    if (language === "kotlin" && node.type === "property_declaration") {
      if (
        node.namedChildren.some((child) => child?.type === "lambda_literal")
      ) {
        return "function";
      }
      return /\bconst\s+val\b/.test(declaration) ||
        /\bval\s+[A-Z][A-Z0-9_]*\b/.test(declaration)
        ? "constant"
        : "variable";
    }
    if (language === "php" && node.type === "enum_case") {
      return "constant";
    }
    if (
      language === "rust" &&
      node.type === "let_declaration" &&
      syntaxDescendants(node).some(
        (child) => child.type === "closure_expression",
      )
    ) {
      return "function";
    }
    if (
      language === "php" &&
      node.type === "expression_statement" &&
      !syntaxDescendants(node).some(
        (child) => child.type === "assignment_expression",
      )
    ) {
      return undefined;
    }
    if (language === "c" && node.type === "field_declaration") {
      return "variable";
    }
    if (language === "cpp" && node.type === "field_declaration") {
      return /\b(?:constexpr|constinit)\b/.test(declaration)
        ? "constant"
        : "variable";
    }
    if (
      (language === "c" || language === "cpp") &&
      node.type === "declaration" &&
      syntaxDescendants(node).some((child) =>
        child.type.includes("function_declarator"),
      )
    ) {
      return "function";
    }
    if (language === "cpp" && node.type === "declaration") {
      return /\b(?:constexpr|constinit)\b/.test(declaration) ||
        /^[A-Z][A-Z0-9_]*\s*(?:=|:)/.test(declaration.trim())
        ? "constant"
        : "variable";
    }
    if (
      (language === "c" || language === "cpp") &&
      node.type === "preproc_function_def"
    ) {
      return "function";
    }
    if (
      (language === "c" || language === "cpp") &&
      node.type === "preproc_def"
    ) {
      return "constant";
    }
    if (
      language === "go" &&
      node.type === "field_declaration" &&
      !syntaxAncestors(node).some((parent) => parent.type === "type_spec")
    ) {
      return undefined;
    }
    if (
      language === "go" &&
      node.type === "short_var_declaration" &&
      !syntaxDescendants(node).some((child) => child.type === "func_literal")
    ) {
      return undefined;
    }
    if (language === "go" && node.type === "const_spec") return "constant";
    if (
      language === "python" &&
      node.type === "expression_statement" &&
      !syntaxDescendants(node).some((child) =>
        ["assignment", "augmented_assignment", "named_expression"].includes(
          child.type,
        ),
      )
    ) {
      return undefined;
    }
    if (
      language === "python" &&
      syntaxDescendants(node).some((child) => child.type === "lambda")
    ) {
      return enclosingContainer(source, node, shape).length > 0
        ? "method"
        : "function";
    }
    const declarator = node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "variable_declarator",
    );
    const rawValue =
      declarator?.childForFieldName("value") ?? node.childForFieldName("value");
    const callableValues = [
      "anonymous_function_creation_expression",
      "arrow_function",
      "func_literal",
      "function_expression",
      "lambda",
      "lambda_literal",
    ];
    const value = rawValue
      ? callableValues.includes(rawValue.type)
        ? rawValue
        : language === "go"
          ? syntaxDescendants(rawValue).find((child) =>
              callableValues.includes(child.type),
            )
          : undefined
      : syntaxDescendants(node).find((child) =>
          callableValues.includes(child.type),
        );
    if (
      value &&
      [
        "anonymous_function_creation_expression",
        "arrow_function",
        "func_literal",
        "function_expression",
        "lambda",
        "lambda_literal",
      ].includes(value.type)
    ) {
      return enclosingContainer(source, node, shape).length > 0
        ? "method"
        : "function";
    }
    if (
      node.type === "enum_member_declaration" ||
      node.type === "enum_constant" ||
      node.type === "enum_variant" ||
      node.type === "enumerator"
    ) {
      return "constant";
    }
    return /\b(?:const|constant|static\s+final)\b/.test(declaration) ||
      /^[A-Z][A-Z0-9_]*\s*(?:=|:)/.test(declaration.trim())
      ? "constant"
      : "variable";
  }
  if (shape.moduleUnits?.has(node.type)) {
    if (language === "kotlin" && node.type === "anonymous_initializer") {
      return "method";
    }
    return "module";
  }
  return undefined;
}

/** Returns whether a node belongs inside another callable's implementation. */
function isNestedImplementation(
  language: TreeSitterLanguage,
  node: SyntaxNode,
  shape: LanguageShape,
  source: string,
) {
  if (language === "php" && node.type === "property_promotion_parameter") {
    return false;
  }
  if (
    language === "rust" &&
    node.type === "let_declaration" &&
    syntaxDescendants(node).some((child) => child.type === "closure_expression")
  ) {
    return false;
  }
  if (
    language === "c" &&
    ["struct_specifier", "union_specifier", "enum_specifier"].includes(
      node.type,
    ) &&
    syntaxAncestors(node).some((parent) => parent.type === "type_definition")
  ) {
    return true;
  }
  if (
    language === "go" &&
    node.type === "short_var_declaration" &&
    syntaxDescendants(node).some((child) => child.type === "func_literal")
  ) {
    return false;
  }
  if (
    language === "java" &&
    shape.functions.has(node.type) &&
    syntaxAncestors(node).some((parent) =>
      ["object_creation_expression", "enum_constant"].includes(parent.type),
    )
  ) {
    return true;
  }
  if (
    language === "kotlin" &&
    shape.functions.has(node.type) &&
    syntaxAncestors(node).some((parent) => parent.type === "object_literal")
  ) {
    return true;
  }
  if (
    language === "java" &&
    node.type === "block" &&
    node.parent?.type === "static_initializer"
  ) {
    return true;
  }
  // Every node property crosses into Wasm, and this runs for each named node in
  // the file, so the immediate parent and each ancestor's type are read once.
  const directParent = node.parent;
  for (let parent = directParent; parent; parent = parent.parent) {
    const type = parent.type;
    if (shape.functions.has(type) || functionBoundaryTypes.has(type)) {
      return (
        !assignmentTypes.has(directParent?.type ?? "") ||
        !directParent ||
        !ownName(source, directParent)
      );
    }
  }
  return false;
}

/** Returns syntax ancestors from the immediate parent to the root. */
function syntaxAncestors(node: SyntaxNode) {
  const ancestors: SyntaxNode[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    ancestors.push(parent);
  }
  return ancestors;
}

/** Detects C and C++ declarations used only as header guards. */
function isHeaderGuardDefinition(source: string, node: SyntaxNode) {
  if (node.type !== "preproc_def") return false;
  const nameNode =
    node.childForFieldName("name") ??
    node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === "identifier",
    );
  const name = nameNode ? nodeText(source, nameNode) : undefined;
  if (!name) return false;
  return syntaxAncestors(node).some(
    (parent) =>
      parent.type === "preproc_ifdef" &&
      nodeText(source, parent).trimStart().startsWith(`#ifndef ${name}`),
  );
}

/** Detects C++ module declarations parsed by older grammar productions. */
function isCppModuleContextNode(source: string, node: SyntaxNode) {
  if (node.type !== "declaration") return false;
  const leaves = syntaxDescendants(node)
    .filter((child) => child.namedChildCount === 0)
    .map((child) => nodeText(source, child));
  return (
    (leaves[0] === "export" && leaves[1] === "module") ||
    leaves[0] === "module" ||
    leaves[0] === "import"
  );
}

/** Returns whether a PHP node represents import-only context. */
function isPhpImportNode(node: SyntaxNode) {
  return (
    node.type === "namespace_use_declaration" ||
    node.type === "declare_statement" ||
    syntaxDescendants(node).some((child) =>
      [
        "include_expression",
        "include_once_expression",
        "require_expression",
        "require_once_expression",
      ].includes(child.type),
    )
  );
}

/** Includes a directly preceding comment in a focused nested unit. */
function precedingCommentStart(source: string, node: SyntaxNode) {
  const statement =
    node.parent?.type === "expression_statement" ? node.parent : node;
  const sibling = statement.previousNamedSibling;
  return sibling &&
    sibling.type === "comment" &&
    source.slice(sibling.endIndex, statement.startIndex).trim() === ""
    ? sibling.startIndex
    : statement.startIndex;
}

/** Node types that hold code to run rather than a value to read. */
const ecmascriptBehaviour = set(
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "class",
  "class_declaration",
);

/**
 * Reports whether a value carries work of its own.
 *
 * A key of an object literal earns a card when something in it executes — a
 * handler, a resolver, a procedure assembled from a chain of calls. A key
 * holding a string, an icon, a shortcut or a flag cannot be judged apart from
 * the object that gives it meaning, and a command table of such keys turns one
 * decision into a card per field. The search is for anything callable anywhere
 * inside the value, because the code is often wrapped: `procedure.query(() =>
 * …)` states its behaviour two calls deep.
 */
function carriesBehaviour(node: SyntaxNode) {
  if (ecmascriptBehaviour.has(node.type)) return true;
  return syntaxDescendants(node).some((descendant) =>
    ecmascriptBehaviour.has(descendant.type),
  );
}

/** Builds focused review units for nested ECMAScript members and hooks. */
function nestedEcmascriptCandidate(
  file: SourceFile,
  language: "javascript" | "typescript",
  node: SyntaxNode,
) {
  if (node.type === "pair") {
    const nameNode = node.childForFieldName("key");
    const name = nameNode
      ? normalizeName(nodeText(file.content, nameNode))
      : undefined;
    const owner = logicalOwnerName(file.content, node);
    if (!name || !owner) return undefined;
    const value = node.childForFieldName("value");
    if (!value || !carriesBehaviour(value)) return undefined;
    const start = precedingCommentStart(file.content, node);
    const ownerDeclaration = (() => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (
          ["lexical_declaration", "variable_declaration"].includes(parent.type)
        ) {
          return parent;
        }
      }
      return undefined;
    })();
    const focusedObject =
      start < node.startIndex ||
      (ownerDeclaration &&
        nodeText(file.content, ownerDeclaration).split("\n").length > 100);
    if (!focusedObject) return undefined;
    const changeType = file.changeType ?? "modified";
    const source = file.content.slice(start, node.endIndex);
    return {
      node,
      ownName: name,
      unit: {
        stableKey: stableReviewKey(file.path, "method", `${owner}.${name}`),
        path: file.path,
        language,
        kind: "method",
        name: `${owner} › ${name}`,
        signature: nodeText(file.content, node).split(/[\n{]/, 1)[0]?.trim(),
        startLine: lineAt(file.content, start),
        endLine: lineAt(file.content, node.endIndex),
        source,
        contentHash: sha256(source),
        semanticHash: "",
        changeType,
        complexity: complexity(node),
        dependencies: [],
      } satisfies RawUnit,
    };
  }
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    const hook = callee
      ? normalizeName(nodeText(file.content, callee))
      : undefined;
    if (!hook || !/^use[A-Z]/.test(hook)) return undefined;
    const owner = logicalOwnerName(file.content, node);
    if (!owner) return undefined;
    const start = precedingCommentStart(file.content, node);
    const comment =
      start < node.startIndex
        ? file.content
            .slice(start, node.startIndex)
            .replace(/^\s*\/\/\s?/, "")
            .trim()
        : undefined;
    const display = [owner, hook, comment].filter(Boolean).join(" › ");
    const changeType = file.changeType ?? "modified";
    const source = file.content.slice(start, node.endIndex);
    return {
      node,
      ownName: hook,
      unit: {
        stableKey: stableReviewKey(file.path, "method", display),
        path: file.path,
        language,
        kind: "method",
        name: display,
        signature: `${hook}(…)`,
        startLine: lineAt(file.content, start),
        endLine: lineAt(file.content, node.endIndex),
        source,
        contentHash: sha256(source),
        semanticHash: "",
        changeType,
        complexity: complexity(node),
        dependencies: [],
      } satisfies RawUnit,
    };
  }
  return undefined;
}

/** Computes lightweight cyclomatic complexity across the parts of a unit. */
function complexity(...parts: Array<SyntaxNode | undefined>) {
  const branching = new Set([
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "case_statement",
    "switch_expression",
    "match_expression",
    "catch_clause",
    "conditional_expression",
  ]);
  return Math.max(
    1,
    1 +
      parts
        .flatMap((part) => (part ? syntaxDescendants(part) : []))
        .filter((descendant) => branching.has(descendant.type)).length,
  );
}

/**
 * Reports whether a declaration is reviewed as a header whose members become
 * units of their own. Such a declaration is truncated to that header, so the
 * body has to be claimed by those members or it is left unreviewed.
 */
function reviewsBodyAsMembers(
  language: TreeSitterLanguage,
  shape: LanguageShape,
  node: SyntaxNode,
) {
  return (
    shape.containers.has(node.type) &&
    !(language === "cpp" && node.type === "enum_specifier")
  );
}

/** Builds a raw review unit from a complete declaration node. */
function makeRawUnit(
  file: SourceFile,
  language: TreeSitterLanguage,
  shape: LanguageShape,
  node: SyntaxNode,
  kind: UnitKind,
  displayName: string,
  stableName: string,
) {
  const start = leadingDocumentationStart(file.content, node, shape, language);
  const wrapper = declarationWrapper(node);
  const trailingBody = shape.containers.has(node.type)
    ? undefined
    : trailingBodySibling(file.content, wrapper, shape);
  const phpStatement =
    language === "php" &&
    (kind === "test" || kind === "test_hook") &&
    node.type === "function_call_expression"
      ? syntaxAncestors(node).find(
          (parent) => parent.type === "expression_statement",
        )
      : undefined;
  const end =
    language === "php" &&
    kind === "test_suite" &&
    node.type === "function_call_expression"
      ? (() => {
          const closure = syntaxDescendants(node).find(
            (child) => child.type === "anonymous_function_creation_expression",
          );
          const body = closure?.childForFieldName("body");
          return body ? body.startIndex + 1 : node.endIndex;
        })()
      : phpStatement
        ? phpStatement.endIndex
        : language === "kotlin" &&
            kind === "test_suite" &&
            node.type === "call_expression"
          ? (() => {
              const lambda = syntaxDescendants(node).find(
                (child) => child.type === "lambda_literal",
              );
              const statements = lambda
                ? syntaxDescendants(lambda).find(
                    (child) => child.type === "statements",
                  )
                : undefined;
              return statements ? statements.startIndex : node.endIndex;
            })()
          : reviewsBodyAsMembers(language, shape, node)
            ? declarationEnd(file.content, node, shape, true)
            : (trailingBody ?? wrapper).endIndex;
  const source = file.content.slice(start, end);
  const changeType = file.changeType ?? "modified";
  return {
    stableKey: stableReviewKey(file.path, kind, stableName),
    path: file.path,
    language,
    kind,
    name: displayName,
    signature: source
      .replace(/^\s*(?:(?:\/\*[\s\S]*?\*\/)|(?:(?:\/\/|#).*\n))+\s*/, "")
      .split(/[\n{]/, 1)[0]
      ?.trim(),
    startLine: lineAt(file.content, start),
    endLine: lineAt(file.content, end),
    source,
    contentHash: sha256(source),
    semanticHash: "",
    changeType,
    complexity: complexity(node, trailingBody),
    dependencies: [],
  } satisfies RawUnit;
}

/** Builds a raw review unit from an explicit Tree-sitter-backed source range. */
function makeRawRangeUnit(
  file: SourceFile,
  language: TreeSitterLanguage,
  kind: UnitKind,
  name: string,
  from: number,
  to: number,
) {
  const source = file.content.slice(from, to);
  const changeType = file.changeType ?? "modified";
  return {
    stableKey: stableReviewKey(file.path, kind, name),
    path: file.path,
    language,
    kind,
    name,
    signature: source.split("\n", 1)[0]?.trim(),
    startLine: lineAt(file.content, from),
    endLine: lineAt(file.content, to),
    source,
    contentHash: sha256(source),
    semanticHash: "",
    changeType,
    complexity: 1,
    dependencies: [],
  } satisfies RawUnit;
}

const semanticDefinitionFields = new Set([
  "alias",
  "declarator",
  "key",
  "left",
  "name",
  "parameter",
  "pattern",
]);

const semanticScopeTypePattern =
  /(?:^|_)(?:class|closure|contract|enum|function|interface|lambda|method|module|namespace|procedure|record|struct|trait)(?:_|$)/;

const semanticDefinitionTypePattern =
  /(?:^|_)(?:alias|assignment|binding|declarator|declaration|definition|field|parameter|pattern|property)(?:_|$)/;

/** Checks whether one syntax node fully contains another. */
function syntaxContains(container: SyntaxNode, child: SyntaxNode) {
  return (
    container.startIndex <= child.startIndex &&
    container.endIndex >= child.endIndex
  );
}

/** Finds the named Tree-sitter field that directly contains a child node. */
function containingField(parent: SyntaxNode, child: SyntaxNode) {
  for (const [index, candidate] of parent.namedChildren.entries()) {
    if (candidate && syntaxContains(candidate, child)) {
      return parent.fieldNameForNamedChild(index);
    }
  }
  return null;
}

/** Classifies one normalized identifier as a binding definition or reference. */
function semanticSymbolRole(language: TreeSitterLanguage, node: SyntaxNode) {
  const shape = shapes[language];
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const type = ancestor.type.toLowerCase();
    const definitionContainer =
      isReviewedType(shape, ancestor.type) ||
      semanticDefinitionTypePattern.test(type);
    if (
      (type.includes("import") ||
        type.includes("include") ||
        type.includes("using")) &&
      !["path", "source", "module"].includes(
        containingField(ancestor, node) ?? "",
      )
    ) {
      return "definition" as const;
    }
    if (!definitionContainer) continue;
    const field = containingField(ancestor, node);
    if (field && semanticDefinitionFields.has(field)) {
      return "definition" as const;
    }
    if (
      type.includes("parameter") &&
      field !== "type" &&
      !syntaxAncestors(node).some(
        (parent) =>
          parent !== ancestor &&
          parent.type.toLowerCase().includes("type") &&
          syntaxContains(ancestor, parent),
      )
    ) {
      return "definition" as const;
    }
    if (
      (type.includes("assignment") || type.includes("declarator")) &&
      ancestor.namedChildren[0] &&
      syntaxContains(ancestor.namedChildren[0], node)
    ) {
      return "definition" as const;
    }
  }
  return "reference" as const;
}

/** Builds the lexical scope chain used for conservative symbol resolution. */
function semanticScopeChain(
  language: TreeSitterLanguage,
  source: string,
  node: SyntaxNode,
  role: SemanticSymbolOccurrence["role"],
) {
  const shape = shapes[language];
  const scopes: string[] = [];
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const boundary =
      shape.containers.has(ancestor.type) ||
      shape.functions.has(ancestor.type) ||
      (semanticScopeTypePattern.test(ancestor.type.toLowerCase()) &&
        !/(?:call|invocation)/.test(ancestor.type.toLowerCase()));
    if (!boundary) continue;
    const field = containingField(ancestor, node);
    if (
      role === "definition" &&
      field === "name" &&
      (shape.containers.has(ancestor.type) ||
        shape.functions.has(ancestor.type))
    ) {
      continue;
    }
    const name = ownName(source, ancestor);
    scopes.push(
      `${ancestor.type}:${normalizeName(name ?? "") || ancestor.startPosition.row + 1}`,
    );
  }
  scopes.push("<file>");
  return [...new Set(scopes)];
}

/** Emits a language-neutral definition/reference stream for one syntax tree. */
export function semanticSymbolOccurrences(
  language: TreeSitterLanguage,
  source: string,
) {
  return withSyntaxTree(language, source, (tree) => {
    const shape = shapes[language];
    const occurrences: SemanticSymbolOccurrence[] = [];
    const seen = new Set<string>();
    for (const node of syntaxDescendants(tree.rootNode)) {
      if (!shape.identifierTypes.has(node.type)) continue;
      const name = normalizeName(nodeText(source, node));
      if (
        !name ||
        name.length > 120 ||
        /\s/u.test(name) ||
        !/[\p{L}_$]/u.test(name)
      ) {
        continue;
      }
      const role = semanticSymbolRole(language, node);
      const scopeChain = semanticScopeChain(language, source, node, role);
      const occurrence = {
        name,
        role,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        scopeChain,
      } satisfies SemanticSymbolOccurrence;
      const key = `${role}:${name}:${occurrence.startLine}:${occurrence.endLine}:${scopeChain.join("/")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      occurrences.push(occurrence);
    }
    return occurrences;
  });
}

const candidateExtractor = createCandidateExtractor({
  annotationText,
  bodyNode,
  callRole,
  candidateKind,
  complexity,
  cppDeclarationName,
  declarationEnd,
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
  precedingCommentStart,
  syntaxAncestors,
  testRole,
});
const { declarationCandidates } = candidateExtractor;
const { connectDependencies, meaningfulNodes } = createDependencyPolicies(
  {
    isCppModuleContextNode,
    isHeaderGuardDefinition,
    isPhpImportNode,
    isReviewedType,
    normalizeName,
    syntaxAncestors,
  },
  candidateExtractor.probes,
);

/**
 * Restores the full extent of a declaration that nothing else reviews.
 *
 * A container is normally truncated to its header so that each member can be
 * signed off on its own. When the grammar exposes no member as a unit — an
 * interface of property signatures, an enum, a table of columns — that
 * truncation leaves the body behind, where it resurfaces as an anonymous
 * module unit a reviewer cannot act on. Such a declaration stays whole.
 */
function retainWholeChildlessDeclarations<
  Candidate extends { node: SyntaxNode; unit: RawUnit },
>(file: SourceFile, language: TreeSitterLanguage, candidates: Candidate[]) {
  const shape = shapes[language];
  for (const candidate of candidates) {
    const { node, unit } = candidate;
    if (!reviewsBodyAsMembers(language, shape, node)) continue;
    const start = leadingDocumentationStart(
      file.content,
      node,
      shape,
      language,
    );
    // Language specialisations compose their own ranges, sometimes spanning a
    // parent they deliberately dropped. Only the standard header truncation
    // describes a body that nothing else reviews, so only it may be undone.
    if (
      unit.startLine !== lineAt(file.content, start) ||
      unit.endLine !==
        lineAt(file.content, declarationEnd(file.content, node, shape, true))
    ) {
      continue;
    }
    const extentEnd = declarationWrapper(node).endIndex;
    if (lineAt(file.content, extentEnd) <= unit.endLine) continue;
    // Recorded whether or not the body is reviewed member by member: a
    // revision that adds the whole declaration has no separate members to
    // sign off, and needs to know how far it reaches to say so.
    unit.bodyEndLine = lineAt(file.content, extentEnd);
    const reviewedByMember = candidates.some(
      (other) =>
        other !== candidate &&
        other.node.startIndex >= node.startIndex &&
        other.node.endIndex <= node.endIndex,
    );
    if (reviewedByMember) continue;
    const source = file.content.slice(start, extentEnd);
    unit.source = source;
    unit.endLine = lineAt(file.content, extentEnd);
    unit.contentHash = sha256(source);
  }
  return candidates;
}

/**
 * Joins the run of declarations that spell one definition into a single unit.
 *
 * Haskell writes a definition as a type signature followed by its equations,
 * each its own node and every one of them carrying the same name. They are one
 * thing to read and one thing to sign off — nobody confirms `quack 0 = …`
 * without `quack _ = …`, and a card per equation gives a reviewer a column of
 * cards that cannot be told apart. A language where two adjacent declarations
 * of one name are genuinely different things, such as a C++ overload set, is
 * not marked and keeps them separate.
 */
function mergeClauseDeclarations<
  Candidate extends { node: SyntaxNode; unit: RawUnit; ownName: string },
>(file: SourceFile, language: TreeSitterLanguage, candidates: Candidate[]) {
  if (!shapes[language].clausesShareOneDeclaration) return candidates;
  const ordered = [...candidates].sort(
    (left, right) => left.node.startIndex - right.node.startIndex,
  );
  const merged: Candidate[] = [];
  for (const candidate of ordered) {
    const previous = merged.at(-1);
    // A signature and the equations beneath it are read as different kinds of
    // node — one is a type, the others are bindings — and are still the one
    // definition, so only the name and the adjacency decide.
    if (
      !previous ||
      !candidate.ownName ||
      previous.ownName !== candidate.ownName
    ) {
      merged.push(candidate);
      continue;
    }
    const start = file.content.indexOf(
      previous.unit.source,
      Math.max(0, previous.node.startIndex - previous.unit.source.length),
    );
    const from = start >= 0 ? start : previous.node.startIndex;
    const source = file.content.slice(from, candidate.node.endIndex);
    previous.unit.source = source;
    previous.unit.endLine = lineAt(file.content, candidate.node.endIndex);
    previous.unit.contentHash = sha256(source);
  }
  return merged;
}

/** Builds the review analyzer for one Tree-sitter supported language. */
export function treeSitterAdapter(
  language: TreeSitterLanguage,
  options?: Pick<LanguageAdapter, "matches">,
): LanguageAdapter {
  return {
    language,
    extensions: supportedExtensions[language],
    fileNames: supportedFileNames[language as keyof typeof supportedFileNames],
    matches: options?.matches,
    reviewsWholeFile: shapes[language].reviewsWholeFile,
    isContextOnly(source) {
      return withSyntaxTree(
        language,
        source,
        (tree) => meaningfulNodes(language, tree.rootNode, source).length === 0,
      );
    },
    analyze(file) {
      const units = withSyntaxTree(language, file.content, (tree) => {
        const candidates = mergeClauseDeclarations(
          file,
          language,
          retainWholeChildlessDeclarations(
            file,
            language,
            declarationCandidates(file, language, tree.rootNode),
          ),
        );
        return connectDependencies(file.content, language, candidates);
      });
      for (const unit of units) {
        unit.semanticHash = sha256(
          `${unit.changeType}:${semanticSource(unit.source, language)}`,
        );
      }
      return units;
    },
  };
}
