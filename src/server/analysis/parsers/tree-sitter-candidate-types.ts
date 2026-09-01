import type { Node as SyntaxNode } from "web-tree-sitter";
import type { TreeSitterLanguage } from "../tree-sitter";
import type { RawUnit, SourceFile, UnitKind } from "../types";
import type { LanguageShape } from "./tree-sitter-language-shapes";

export interface ReviewCandidate {
  node: SyntaxNode;
  unit: RawUnit;
  ownName: string;
}

export interface CallRole {
  kind: "test" | "test_hook" | "test_suite";
  name: string;
}

/** Shared adapter operations used by language-specific candidate strategies. */
export interface CandidateToolkit {
  annotationText(
    source: string,
    language: TreeSitterLanguage,
    node: SyntaxNode,
  ): string;
  bodyNode(node: SyntaxNode, shape: LanguageShape): SyntaxNode | undefined;
  callRole(source: string, node: SyntaxNode): CallRole | undefined;
  candidateKind(
    language: TreeSitterLanguage,
    node: SyntaxNode,
    shape: LanguageShape,
    source: string,
  ): UnitKind | undefined;
  complexity(...parts: Array<SyntaxNode | undefined>): number;
  cppDeclarationName(source: string, node: SyntaxNode): string | undefined;
  declarationEnd(
    source: string,
    node: SyntaxNode,
    shape: LanguageShape,
    shell: boolean,
  ): number;
  declarationScopes(
    language: TreeSitterLanguage,
    source: string,
    node: SyntaxNode,
    shape: LanguageShape,
  ): string[];
  enclosingContainer(
    source: string,
    node: SyntaxNode,
    shape: LanguageShape,
  ): string[];
  isCppModuleContextNode(source: string, node: SyntaxNode): boolean;
  isHeaderGuardDefinition(source: string, node: SyntaxNode): boolean;
  isNestedImplementation(
    language: TreeSitterLanguage,
    node: SyntaxNode,
    shape: LanguageShape,
    source: string,
  ): boolean;
  isPhpImportNode(node: SyntaxNode): boolean;
  leadingDocumentationStart(
    source: string,
    node: SyntaxNode,
    shape: LanguageShape,
    language?: TreeSitterLanguage,
  ): number;
  makeRawRangeUnit(
    file: SourceFile,
    language: TreeSitterLanguage,
    kind: UnitKind,
    name: string,
    from: number,
    to: number,
  ): RawUnit;
  makeRawUnit(
    file: SourceFile,
    language: TreeSitterLanguage,
    shape: LanguageShape,
    node: SyntaxNode,
    kind: UnitKind,
    displayName: string,
    stableName: string,
  ): RawUnit;
  nestedEcmascriptCandidate(
    file: SourceFile,
    language: "javascript" | "typescript",
    node: SyntaxNode,
  ): ReviewCandidate | undefined;
  ownName(source: string, node: SyntaxNode): string | undefined;
  precedingCommentStart(source: string, node: SyntaxNode): number;
  syntaxAncestors(node: SyntaxNode): SyntaxNode[];
  testRole(
    file: SourceFile,
    language: TreeSitterLanguage,
    node: SyntaxNode,
    name: string,
    source: string,
  ): UnitKind | undefined;
}

export interface CandidateStrategy {
  extract?: (file: SourceFile, root: SyntaxNode) => ReviewCandidate[];
  specialize?: (
    file: SourceFile,
    language: TreeSitterLanguage,
    root: SyntaxNode,
    candidates: ReviewCandidate[],
  ) => ReviewCandidate[];
}
