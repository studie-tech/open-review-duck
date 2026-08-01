import type { Node as SyntaxNode } from "web-tree-sitter";
import { semanticSource, sha256, stableReviewKey } from "../hash";
import {
  nodeText,
  syntaxDescendants,
  type TreeSitterLanguage,
  withSyntaxTree,
} from "../tree-sitter";
import {
  type AnalyzedUnit,
  type LanguageAdapter,
  type SourceFile,
  supportedExtensions,
  supportedFileNames,
  type UnitKind,
} from "../types";

type RawUnit = Omit<AnalyzedUnit, "depth" | "reviewOrder">;

interface LanguageShape {
  containers: ReadonlySet<string>;
  functions: ReadonlySet<string>;
  variables: ReadonlySet<string>;
  moduleUnits?: ReadonlySet<string>;
  imports: ReadonlySet<string>;
  comments: ReadonlySet<string>;
  identifierTypes: ReadonlySet<string>;
  bodyTypes: ReadonlySet<string>;
}

export interface SemanticSymbolOccurrence {
  name: string;
  role: "definition" | "reference";
  startLine: number;
  endLine: number;
  scopeChain: string[];
}

/** Creates an immutable-by-convention syntax-node type set. */
const set = (...values: string[]) => new Set(values);

const commonIdentifiers = set(
  "atom",
  "class_name",
  "constructor",
  "field_name",
  "identifier",
  "id",
  "long_identifier",
  "lower_case_identifier",
  "message_name",
  "module_identifier",
  "module_name",
  "name",
  "type_identifier",
  "type_name",
  "field_identifier",
  "function_name",
  "namespace_identifier",
  "constant",
  "simple_identifier",
  "simple_name",
  "symbol",
  "sym_name",
  "upper_case_identifier",
  "value_identifier",
  "value_name",
  "variable",
  "variable_name",
  "word",
);

const shapes: Record<TreeSitterLanguage, LanguageShape> = {
  javascript: {
    containers: set(
      "class_declaration",
      "abstract_class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
    ),
    functions: set(
      "function_declaration",
      "generator_function_declaration",
      "function_signature",
      "method_definition",
      "abstract_method_signature",
      "method_signature",
    ),
    variables: set(
      "lexical_declaration",
      "variable_declaration",
      "public_field_definition",
      "required_parameter",
      "optional_parameter",
    ),
    imports: set("import_statement"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("class_body", "statement_block", "object_type"),
  },
  typescript: {
    containers: set(
      "class_declaration",
      "abstract_class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "internal_module",
    ),
    functions: set(
      "function_declaration",
      "generator_function_declaration",
      "function_signature",
      "method_definition",
      "abstract_method_signature",
      "method_signature",
    ),
    variables: set(
      "lexical_declaration",
      "variable_declaration",
      "public_field_definition",
    ),
    imports: set("import_statement"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("class_body", "statement_block", "object_type", "enum_body"),
  },
  python: {
    containers: set("class_definition"),
    functions: set("function_definition"),
    variables: set("expression_statement", "type_alias_statement"),
    imports: set(
      "import_statement",
      "import_from_statement",
      "future_import_statement",
    ),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block"),
  },
  java: {
    containers: set(
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "record_declaration",
      "annotation_type_declaration",
    ),
    functions: set(
      "method_declaration",
      "constructor_declaration",
      "compact_constructor_declaration",
      "annotation_type_element_declaration",
    ),
    variables: set(
      "field_declaration",
      "constant_declaration",
      "enum_constant",
      "record_component",
    ),
    moduleUnits: set("static_initializer", "block"),
    imports: set("package_declaration", "import_declaration"),
    comments: set("line_comment", "block_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set(
      "class_body",
      "interface_body",
      "enum_body",
      "constructor_body",
      "block",
    ),
  },
  csharp: {
    containers: set(
      "class_declaration",
      "interface_declaration",
      "struct_declaration",
      "record_declaration",
      "enum_declaration",
    ),
    functions: set(
      "method_declaration",
      "constructor_declaration",
      "destructor_declaration",
      "operator_declaration",
      "conversion_operator_declaration",
      "local_function_statement",
      "delegate_declaration",
    ),
    variables: set(
      "field_declaration",
      "property_declaration",
      "event_field_declaration",
      "enum_member_declaration",
    ),
    moduleUnits: set("global_statement"),
    imports: set("using_directive", "extern_alias_directive"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("declaration_list", "block", "enum_member_declaration_list"),
  },
  cpp: {
    containers: set(
      "class_specifier",
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
      "concept_definition",
      "type_definition",
      "alias_declaration",
    ),
    functions: set("function_definition"),
    variables: set(
      "declaration",
      "field_declaration",
      "enumerator",
      "preproc_def",
      "preproc_function_def",
    ),
    imports: set(
      "preproc_include",
      "preproc_call",
      "module_declaration",
      "import_declaration",
      "namespace_alias_definition",
    ),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set(
      "field_declaration_list",
      "compound_statement",
      "enumerator_list",
    ),
  },
  php: {
    containers: set(
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
    ),
    functions: set("function_definition", "method_declaration"),
    variables: set(
      "property_declaration",
      "property_promotion_parameter",
      "const_declaration",
      "enum_case",
      "expression_statement",
    ),
    imports: set(
      "declare_statement",
      "namespace_use_declaration",
      "namespace_name",
      "php_tag",
      "text",
    ),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set(
      "declaration_list",
      "compound_statement",
      "enum_declaration_list",
    ),
  },
  shell: {
    containers: set(),
    functions: set("function_definition"),
    variables: set("variable_assignment"),
    moduleUnits: set("command", "pipeline", "list"),
    imports: set("comment"),
    comments: set("comment"),
    identifierTypes: set("variable_name", "word", "command_name"),
    bodyTypes: set("compound_statement", "do_group"),
  },
  c: {
    containers: set(
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
      "type_definition",
    ),
    functions: set("function_definition"),
    variables: set(
      "declaration",
      "field_declaration",
      "enumerator",
      "preproc_def",
      "preproc_function_def",
    ),
    imports: set("preproc_include", "preproc_call"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set(
      "field_declaration_list",
      "compound_statement",
      "enumerator_list",
    ),
  },
  ruby: {
    containers: set("class", "module", "singleton_class"),
    functions: set("method", "singleton_method"),
    variables: set("assignment", "operator_assignment", "alias"),
    moduleUnits: set("call"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: set(
      ...commonIdentifiers,
      "method",
      "constant",
      "instance_variable",
      "class_variable",
      "global_variable",
    ),
    bodyTypes: set("body_statement", "do_block", "block"),
  },
  hcl: {
    containers: set("block"),
    functions: set(),
    variables: set("attribute"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: set("identifier", "get_attr"),
    bodyTypes: set("body"),
  },
  rust: {
    containers: set(
      "struct_item",
      "enum_item",
      "union_item",
      "trait_item",
      "impl_item",
      "mod_item",
      "foreign_mod_item",
    ),
    functions: set("function_item", "function_signature_item"),
    variables: set(
      "const_item",
      "static_item",
      "field_declaration",
      "ordered_field_declaration",
      "enum_variant",
      "let_declaration",
      "associated_type",
      "type_item",
    ),
    moduleUnits: set("macro_definition", "macro_invocation"),
    imports: set(
      "attribute_item",
      "shebang",
      "use_declaration",
      "extern_crate_declaration",
      "inner_attribute_item",
    ),
    comments: set("line_comment", "block_comment"),
    identifierTypes: set(...commonIdentifiers, "scoped_identifier"),
    bodyTypes: set(
      "declaration_list",
      "field_declaration_list",
      "enum_variant_list",
      "block",
    ),
  },
  lua: {
    containers: set(),
    functions: set(
      "function_definition_statement",
      "local_function_definition_statement",
    ),
    variables: set("local_variable_declaration", "variable_assignment"),
    moduleUnits: set("call"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: set("identifier", "variable", "dot_index_expression"),
    bodyTypes: set("block"),
  },
  go: {
    containers: set("type_alias", "type_spec"),
    functions: set(
      "function_declaration",
      "method_declaration",
      "method_elem",
      "method_spec",
    ),
    variables: set(
      "const_spec",
      "field_declaration",
      "short_var_declaration",
      "var_spec",
    ),
    imports: set("package_clause", "import_declaration"),
    comments: set("comment"),
    identifierTypes: set(
      ...commonIdentifiers,
      "field_identifier",
      "package_identifier",
    ),
    bodyTypes: set("field_declaration_list", "block"),
  },
  makefile: {
    containers: set("conditional"),
    functions: set(),
    variables: set("variable_assignment", "define_directive"),
    moduleUnits: set("rule"),
    imports: set("include_directive", "vpath_directive"),
    comments: set("comment"),
    identifierTypes: set("word", "variable", "variable_reference"),
    bodyTypes: set("recipes"),
  },
  kotlin: {
    containers: set(
      "class_declaration",
      "object_declaration",
      "companion_object",
      "type_alias",
    ),
    functions: set("function_declaration", "secondary_constructor"),
    variables: set("class_parameter", "property_declaration", "enum_entry"),
    moduleUnits: set("anonymous_initializer"),
    imports: set("package_header", "import_header", "import_list"),
    comments: set("line_comment", "multiline_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("class_body", "function_body", "block"),
  },
  css: {
    containers: set("rule_set", "media_statement", "keyframes_statement"),
    functions: set(),
    variables: set("declaration"),
    imports: set("import_statement"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block"),
  },
  dart: {
    containers: set(
      "class_definition",
      "enum_declaration",
      "extension_declaration",
      "mixin_declaration",
      "type_alias",
    ),
    functions: set(
      "function_signature",
      "method_signature",
      "getter_signature",
      "setter_signature",
      "constructor_signature",
    ),
    variables: set("declaration", "enum_constant"),
    imports: set(
      "import_or_export",
      "library_name",
      "part_declaration",
      "part_of_declaration",
    ),
    comments: set("comment", "documentation_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("class_body", "function_body", "block"),
  },
  elisp: {
    containers: set(),
    functions: set("function_definition"),
    variables: set("variable_definition", "constant_definition"),
    moduleUnits: set("feature_provide"),
    imports: set("feature_require"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("list"),
  },
  elixir: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set(),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("do_block"),
  },
  elm: {
    containers: set("type_declaration", "type_alias_declaration"),
    functions: set("value_declaration"),
    variables: set("port_annotation"),
    imports: set("module_declaration", "import_clause"),
    comments: set("line_comment", "block_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("let_in_expr", "case_of_expr"),
  },
  embedded_template: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("directive"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("code"),
  },
  html: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set(),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("element"),
  },
  json: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set(),
    imports: set(),
    comments: set(),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("object", "array"),
  },
  objc: {
    containers: set(
      "class_interface",
      "class_implementation",
      "category_interface",
      "category_implementation",
      "protocol_declaration",
      "struct_specifier",
      "enum_specifier",
    ),
    functions: set(
      "function_definition",
      "method_declaration",
      "method_definition",
    ),
    variables: set("declaration", "field_declaration", "property_declaration"),
    imports: set("preproc_include", "preproc_import"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set(
      "compound_statement",
      "field_declaration_list",
      "implementation_definition",
    ),
  },
  ocaml: {
    containers: set(
      "module_definition",
      "module_type_definition",
      "class_definition",
      "type_definition",
    ),
    functions: set("value_definition"),
    variables: set("external", "instance_variable_definition"),
    imports: set("open_module", "include_module"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("structure", "class_body"),
  },
  ql: {
    containers: set("dataclass", "module"),
    functions: set("predicate", "classlessPredicate"),
    variables: set("select", "moduleMember"),
    imports: set("importDirective"),
    comments: set("lineComment", "blockComment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("moduleBody", "predicateBody"),
  },
  rescript: {
    containers: set(
      "module_declaration",
      "module_type_declaration",
      "type_declaration",
    ),
    functions: set(),
    variables: set("let_declaration"),
    imports: set("open_statement", "include_statement"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block"),
  },
  scala: {
    containers: set(
      "class_definition",
      "trait_definition",
      "object_definition",
      "enum_definition",
      "type_definition",
    ),
    functions: set("function_definition", "function_declaration"),
    variables: set(
      "val_definition",
      "var_definition",
      "given_definition",
      "enum_case_definitions",
    ),
    imports: set("package_clause", "import_declaration", "export_declaration"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("template_body", "block"),
  },
  solidity: {
    containers: set(
      "contract_declaration",
      "interface_declaration",
      "library_declaration",
      "struct_declaration",
      "enum_declaration",
    ),
    functions: set(
      "function_definition",
      "constructor_definition",
      "modifier_definition",
      "fallback_receive_definition",
    ),
    variables: set(
      "state_variable_declaration",
      "event_definition",
      "error_declaration",
      "enum_value",
    ),
    imports: set("import_directive", "pragma_directive"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("contract_body", "function_body", "block_statement"),
  },
  swift: {
    containers: set(
      "class_declaration",
      "struct_declaration",
      "protocol_declaration",
      "enum_declaration",
      "extension_declaration",
      "typealias_declaration",
    ),
    functions: set(
      "function_declaration",
      "initializer_declaration",
      "deinitializer_declaration",
      "subscript_declaration",
    ),
    variables: set(
      "property_declaration",
      "constant_declaration",
      "enum_entry",
    ),
    imports: set("import_declaration"),
    comments: set("comment", "multiline_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("class_body", "function_body", "statements"),
  },
  systemrdl: {
    containers: set("component_named_def", "enum_def", "struct_def"),
    functions: set(),
    variables: set("component_inst", "property_assignment"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("component_body"),
  },
  tlaplus: {
    containers: set("module"),
    functions: set("operator_definition", "function_definition"),
    variables: set("constant_declaration", "variable_declaration"),
    imports: set("extends", "instance"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("source_file"),
  },
  toml: {
    containers: set("table", "table_array_element"),
    functions: set(),
    variables: set("pair"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("document"),
  },
  vue: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("script_element", "template_element", "style_element"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("element"),
  },
  yaml: {
    containers: set(),
    functions: set(),
    variables: set("block_mapping_pair", "flow_pair"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block_mapping", "block_sequence"),
  },
  zig: {
    containers: set(
      "struct_declaration",
      "enum_declaration",
      "union_declaration",
      "opaque_declaration",
    ),
    functions: set("function_declaration"),
    variables: set("variable_declaration", "field_declaration"),
    imports: set(),
    comments: set("line_comment", "doc_comment", "container_doc_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block"),
  },
  sql: {
    containers: set(
      "create_table",
      "create_view",
      "create_type",
      "create_schema",
    ),
    functions: set("create_function", "create_procedure", "create_trigger"),
    variables: set("create_index", "alter_table", "drop_statement"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("column_definitions", "block"),
  },
  markdown: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("section"),
    imports: set(),
    comments: set("html_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("document"),
  },
  mdx: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("section"),
    imports: set("mdx_esm_block"),
    comments: set("html_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("document"),
  },
  dockerfile: {
    containers: set("stage"),
    functions: set(),
    variables: set("arg_instruction", "env_instruction"),
    moduleUnits: set(
      "from_instruction",
      "run_instruction",
      "copy_instruction",
      "add_instruction",
      "cmd_instruction",
      "entrypoint_instruction",
    ),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("source_file"),
  },
  graphql: {
    containers: set(
      "object_type_definition",
      "interface_type_definition",
      "input_object_type_definition",
      "enum_type_definition",
      "union_type_definition",
      "scalar_type_definition",
      "schema_definition",
    ),
    functions: set("operation_definition", "fragment_definition"),
    variables: set("field_definition", "enum_value_definition"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("fields_definition", "selection_set"),
  },
  prisma: {
    containers: set(
      "model_block",
      "enum_block",
      "type_block",
      "datasource_block",
      "generator_block",
    ),
    functions: set(),
    variables: set("model_field", "enum_value"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("source_file"),
  },
  protobuf: {
    containers: set("message", "enum", "service", "extend", "group"),
    functions: set("rpc"),
    variables: set("field", "enum_field", "oneof_field", "option"),
    imports: set("syntax", "package", "import"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("message_body", "enum_body", "service_body", "oneof_body"),
  },
  xml: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set(),
    imports: set("XMLDecl", "doctype"),
    comments: set("Comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("element", "content"),
  },
  scss: {
    containers: set("rule_set", "media_statement", "mixin_statement"),
    functions: set("function_statement", "mixin_statement"),
    variables: set("declaration"),
    imports: set("import_statement", "use_statement", "forward_statement"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block"),
  },
  svelte: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("script_element", "style_element", "element"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("document"),
  },
  astro: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("frontmatter", "element"),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("document"),
  },
  r: {
    containers: set(
      "s4_class_definition",
      "r6_class_definition",
      "rc_class_definition",
    ),
    functions: set(),
    variables: set("binary_operator"),
    imports: set("namespace_operator"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("braced_expression"),
  },
  julia: {
    containers: set(
      "struct_definition",
      "abstract_definition",
      "primitive_definition",
      "module_definition",
      "macro_definition",
    ),
    functions: set(
      "function_definition",
      "short_function_definition",
      "macro_definition",
    ),
    variables: set(
      "const_statement",
      "assignment",
      "typed_expression",
      "export_statement",
    ),
    imports: set("import_statement", "using_statement"),
    comments: set("line_comment", "block_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block"),
  },
  haskell: {
    containers: set(
      "data_type",
      "newtype",
      "class",
      "instance",
      "type_synomym",
    ),
    functions: set("function", "signature"),
    variables: set("bind", "pattern_synonym"),
    imports: set("header", "import"),
    comments: set("comment", "haddock"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("declarations", "where"),
  },
  clojure: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set(),
    imports: set(),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("list_lit"),
  },
  erlang: {
    containers: set("record_decl", "type_alias"),
    functions: set("fun_decl"),
    variables: set("spec", "callback", "macro_def"),
    imports: set(
      "module_attribute",
      "export_attribute",
      "import_attribute",
      "include_attribute",
      "include_lib_attribute",
    ),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("function_clause", "clause_body"),
  },
  fsharp: {
    containers: set(
      "named_module",
      "type_definition",
      "class_definition",
      "interface_definition",
    ),
    functions: set("function_or_value_defn", "member_defn"),
    variables: set("record_field", "union_case"),
    imports: set("open_statement", "namespace"),
    comments: set("line_comment", "block_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("module_body", "class_body"),
  },
  powershell: {
    containers: set("class_statement", "enum_statement"),
    functions: set("function_statement", "method_statement"),
    variables: set("assignment_expression", "property_statement"),
    imports: set("using_statement", "requires_statement"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("script_block", "statement_block"),
  },
  fortran: {
    containers: set(
      "module",
      "submodule",
      "derived_type_definition",
      "interface",
    ),
    functions: set("function", "subroutine"),
    variables: set("variable_declaration", "parameter_statement"),
    imports: set("use_statement", "include_statement"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("internal_procedures", "translation_unit"),
  },
  perl: {
    containers: set("package_statement", "class_definition"),
    functions: set("function_definition", "method_definition"),
    variables: set(
      "variable_declaration",
      "assignment_expression",
      "constant_declaration",
    ),
    imports: set("use_statement", "require_expression"),
    comments: set("comment", "pod"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("block"),
  },
  groovy: {
    containers: set(
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "trait_declaration",
    ),
    functions: set(
      "method_declaration",
      "constructor_declaration",
      "function_declaration",
    ),
    variables: set(
      "field_declaration",
      "variable_declaration",
      "property_declaration",
    ),
    imports: set("package_declaration", "import_declaration"),
    comments: set("line_comment", "block_comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("class_body", "block"),
  },
  nix: {
    containers: set(),
    functions: set("function_expression"),
    variables: set("binding"),
    imports: set("with_expression"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("binding_set", "attrset_expression"),
  },
  latex: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("chapter", "section", "subsection", "subsubsection"),
    imports: set("package_include", "class_include"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("source_file"),
  },
  systemverilog: {
    containers: set(
      "module_declaration",
      "interface_declaration",
      "program_declaration",
      "class_declaration",
      "package_declaration",
      "checker_declaration",
    ),
    functions: set(
      "function_declaration",
      "task_declaration",
      "constructor_declaration",
    ),
    variables: set(
      "data_declaration",
      "parameter_declaration",
      "net_declaration",
    ),
    imports: set(
      "package_import_declaration",
      "include_compiler_directive",
      "timescale_compiler_directive",
    ),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set(
      "function_body_declaration",
      "task_body_declaration",
      "class_body",
    ),
  },
  assembly: {
    containers: set(),
    functions: set(),
    variables: set(),
    moduleUnits: set("label"),
    imports: set("include"),
    comments: set("comment"),
    identifierTypes: commonIdentifiers,
    bodyTypes: set("program"),
  },
};

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
  "teardown",
  "aftertest",
]);

/** Returns the one-based source line containing an offset. */
function lineAt(source: string, offset: number) {
  return source.slice(0, offset).split("\n").length;
}

/** Returns the first named leaf token represented by a syntax subtree. */
function namedLeafText(source: string, node: SyntaxNode): string | undefined {
  if (node.namedChildCount === 0) return nodeText(source, node);
  const preferred =
    node.childForFieldName("name") ??
    node.childForFieldName("declarator") ??
    node.childForFieldName("left") ??
    node.childForFieldName("target");
  return preferred ? namedLeafText(source, preferred) : undefined;
}

/** Locates the syntax node that owns a declaration's name. */
function declarationNameNode(node: SyntaxNode): SyntaxNode | undefined {
  const direct =
    node.childForFieldName("name") ??
    node.childForFieldName("declarator") ??
    node.childForFieldName("left") ??
    node.childForFieldName("target");
  if (direct) {
    const nested = declarationNameNode(direct);
    return nested ?? direct;
  }
  const declarator = node.namedChildren.find(
    (child): child is SyntaxNode =>
      child !== null &&
      [
        "assignment",
        "const_spec",
        "init_declarator",
        "variable_declarator",
        "variable_declaration",
      ].includes(child.type),
  );
  if (declarator) return declarationNameNode(declarator);
  const nestedDeclarator = node.namedChildren.find(
    (child): child is SyntaxNode => Boolean(child?.type.includes("declarator")),
  );
  if (nestedDeclarator) return declarationNameNode(nestedDeclarator);
  return node.namedChildren.find(
    (child): child is SyntaxNode =>
      child !== null && commonIdentifiers.has(child.type),
  );
}

/** Normalizes a declaration token for same-file dependency matching. */
function normalizeName(value: string | undefined) {
  return value
    ?.trim()
    .replace(/^[$@]+/, "")
    .match(/[A-Za-z_][\w$!?=<>+\-*/%[\]]*/)?.[0];
}

/** Extracts the semantic name owned by a declaration node. */
function ownName(source: string, node: SyntaxNode) {
  if (node.type.startsWith("create_")) {
    const name =
      /^\s*create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|view|index|schema|type|function|procedure|trigger)\s+(?:if\s+not\s+exists\s+)?([^\s(;]+)/i.exec(
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
  const nameNode = declarationNameNode(node);
  const fieldName = normalizeName(
    nameNode ? namedLeafText(source, nameNode) : undefined,
  );
  if (fieldName) return fieldName;
  return normalizeName(nodeText(source, node));
}

/** Extracts C++ names, including operators and test-framework cases. */
function cppDeclarationName(source: string, node: SyntaxNode) {
  if (shapes.cpp.containers.has(node.type)) return ownName(source, node);
  const text = nodeText(source, node);
  const fixture =
    /\bTEST_F\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(text);
  if (fixture?.[1] && fixture[2]) return `${fixture[1]} › ${fixture[2]}`;
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
          (declarationNameNode(node)?.startIndex ?? node.endIndex)
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
    (shape.comments.has(sibling.type) || sibling.type.includes("attribute")) &&
    source.slice(sibling.endIndex, start).trim() === ""
  ) {
    const text = nodeText(source, sibling).trim();
    const documentation =
      sibling.type.includes("attribute") ||
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
function annotationText(source: string, node: SyntaxNode) {
  const start = leadingDocumentationStart(source, node, {
    ...shapes.javascript,
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
  const prefix = annotationText(source, node).toLowerCase();
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
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      shape.functions.has(parent.type) ||
      functionBoundaryTypes.has(parent.type)
    ) {
      const directParent = node.parent;
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

/** Computes lightweight cyclomatic complexity from branching syntax nodes. */
function complexity(node: SyntaxNode) {
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
      syntaxDescendants(node).filter((descendant) =>
        branching.has(descendant.type),
      ).length,
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
          : shape.containers.has(node.type) &&
              !(language === "cpp" && node.type === "enum_specifier")
            ? declarationEnd(file.content, node, shape, true)
            : wrapper === node
              ? node.endIndex
              : wrapper.endIndex;
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
    complexity: complexity(node),
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

/** Extracts the assigned variable path from a Lua declaration. */
function luaVariableName(source: string, node: SyntaxNode) {
  const list = node.namedChildren.find(
    (child): child is SyntaxNode =>
      child !== null && child.type === "variable_list",
  );
  const variable = list?.namedChildren.find(
    (child): child is SyntaxNode => child !== null && child.type === "variable",
  );
  return variable ? nodeText(source, variable) : undefined;
}

/** Returns the semantic targets declared by a Make rule. */
function makeRuleTargets(source: string, node: SyntaxNode) {
  const targets = node.namedChildren.find(
    (child): child is SyntaxNode => child !== null && child.type === "targets",
  );
  return (
    targets?.namedChildren
      .filter((child): child is SyntaxNode => child !== null)
      .map((child) => nodeText(source, child).split("\n").at(-1)?.trim() ?? "")
      .filter(Boolean) ?? []
  );
}

/** Recovers the true Make rule start after a grammar recovery node. */
function makeRuleStart(source: string, node: SyntaxNode) {
  const targets = node.namedChildren.find(
    (child): child is SyntaxNode => child !== null && child.type === "targets",
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
  const add = (
    node: SyntaxNode,
    kind: UnitKind,
    name: string,
    ownName: string,
    start = rubyDocumentationStart(source, node),
    end = node.endIndex,
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
    if (node.type !== "method") continue;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;
    const methodName = nodeText(source, nameNode);
    const scope = rubyScope(source, node);
    const name = scope.testSuite
      ? `${scope.name.split("::").at(-1)} › ${methodName}`
      : `${scope.name}${scope.singleton ? "." : "#"}${methodName}`;
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
      .filter((argument) => ["simple_symbol", "string"].includes(argument.type))
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
        suiteCalls.has(method) || exampleCalls.has(method) || method === "test"
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
    const stableName = occurrence === 1 ? ownName : `${ownName}#${occurrence}`;
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
      targets !== undefined && /^-{5,}.*-{5,}$/.test(nodeText(source, targets))
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
    const ruleLineStart = source.lastIndexOf("\n", recoveredRuleStart - 1) + 1;
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
          ? leadingDocumentationStart(source, rule, shapes.makefile, "makefile")
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
  const values = node.namedChildren.find(
    (child): child is SyntaxNode =>
      child !== null && child.type === "expression_list",
  );
  return values?.namedChildren.find(
    (child): child is SyntaxNode => child !== null,
  );
}

/** Extracts a Lua require specifier, including grammar recovery nodes. */
function luaRequireSpec(source: string, node: SyntaxNode) {
  const call =
    node.type === "call"
      ? node
      : syntaxDescendants(node).find((child) => child.type === "call");
  const requireNode = call
    ? call.childForFieldName("function")
    : syntaxDescendants(node).find(
        (child) =>
          child.type === "ERROR" &&
          nodeText(source, child).trimStart().startsWith("require"),
      );
  if (!requireNode || !nodeText(source, requireNode).startsWith("require")) {
    return undefined;
  }
  const specifier = syntaxDescendants(call ?? node).find(
    (child) => child.type === "string",
  );
  return specifier
    ? nodeText(source, specifier).replace(/^["']|["']$/g, "")
    : undefined;
}

/** Extends a recovered Lua DSL call through its callback body. */
function luaCallRange(node: SyntaxNode, source: string) {
  const sibling = node.nextNamedSibling;
  if (
    sibling?.type === "ERROR" &&
    source.slice(node.endIndex, sibling.endIndex).trimStart().startsWith(",")
  ) {
    return { start: node.startIndex, end: sibling.endIndex, node: sibling };
  }
  return { start: node.startIndex, end: node.endIndex, node };
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
  const returnedModules = new Set(
    root.namedChildren
      .filter(
        (node): node is SyntaxNode =>
          node !== null && node.type === "return_statement",
      )
      .map((node) => {
        const variable = syntaxDescendants(node).find(
          (child) => child.type === "variable",
        );
        return variable ? nodeText(source, variable) : "";
      })
      .filter(Boolean),
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
    if (
      node.type === "local_variable_declaration" ||
      node.type === "variable_assignment"
    ) {
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
        value.type === "table" &&
        (/@class\b/.test(documented) || /^Test[A-Z_]/.test(name))
      ) {
        add(node, "class", `Class ${name}`, name);
      } else if (!returnedModules.has(name)) {
        add(
          node,
          /^[A-Z][A-Z0-9_]*$/.test(name) || value.type === "table"
            ? "constant"
            : "variable",
          name,
          name,
        );
      }
      continue;
    }
    if (
      node.type === "local_function_definition_statement" ||
      node.type === "function_definition_statement"
    ) {
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
    .filter((node) => node.type === "call")
    .map((node) => {
      const role = callRole(source, node);
      return role
        ? { node, role, range: luaCallRange(node, source) }
        : undefined;
    })
    .filter(
      (
        call,
      ): call is {
        node: SyntaxNode;
        role: NonNullable<ReturnType<typeof callRole>>;
        range: ReturnType<typeof luaCallRange>;
      } => call !== undefined,
    );
  const suites = calls.filter(({ role }) => role.kind === "test_suite");
  for (const call of calls) {
    const parents = suites
      .filter(
        (suite) =>
          suite.node.startIndex < call.node.startIndex &&
          suite.range.end >= call.range.end,
      )
      .sort((left, right) => left.node.startIndex - right.node.startIndex);
    const ownLabel =
      call.role.kind === "test_hook"
        ? call.role.name.replaceAll("_", " ")
        : call.role.name;
    const name = [...parents.map(({ role }) => role.name), ownLabel].join(
      " › ",
    );
    add(
      call.range.node,
      call.role.kind,
      name,
      name,
      call.node.startIndex,
      call.range.end,
    );
  }

  for (const statement of root.namedChildren) {
    if (statement?.type !== "return_statement") continue;
    const variable = syntaxDescendants(statement).find(
      (child) => child.type === "variable",
    );
    if (!variable) continue;
    const name = nodeText(source, variable);
    add(statement, "module", `Module ${name}`, name);
  }

  if (candidates.length === 0) {
    const executable = root.namedChildren.filter(
      (node): node is SyntaxNode =>
        node !== null &&
        !shapes.lua.comments.has(node.type) &&
        !(
          node.type === "local_variable_declaration" &&
          syntaxDescendants(node).some(
            (child) =>
              child.type === "call" &&
              nodeText(source, child.childForFieldName("function") ?? child) ===
                "require",
          )
        ) &&
        !(
          node.type === "call" &&
          nodeText(source, node.childForFieldName("function") ?? node) ===
            "require"
        ),
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
    node.type === "call_expression" ? node.childForFieldName("function") : node;
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
  if (lowerPath.includes("step") || lowerPath.includes("use")) return undefined;
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
          suite.startIndex < node.startIndex && suite.endIndex >= node.endIndex,
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
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
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
        ["comment", "export_statement", "import_statement"].includes(node.type),
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
        add(node, "test_hook", `mock provider ${labels[0] ?? ""}`.trim(), type);
      } else if (type === "variables") {
        add(node, "test_hook", "variables", type);
      } else if (type === "run") {
        add(node, "test", `Run ${labels[0] ?? ""}`.trim(), `run.${labels[0]}`);
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
        if (name) add(attribute, "variable", `Local ${name}`, `local.${name}`);
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
    add(body, "module", "HCL statements", "statements", 0, file.content.length);
  }
  return candidates;
}

/** Extracts language-aware declaration candidates from one syntax tree. */
function declarationCandidates(
  file: SourceFile,
  language: TreeSitterLanguage,
  root: SyntaxNode,
) {
  const shape = shapes[language];
  if (language === "shell") return shellReviewCandidates(file, root);
  if (language === "ruby") return rubyReviewCandidates(file, root);
  if (language === "makefile") return makeReviewCandidates(file, root);
  if (language === "lua") return luaReviewCandidates(file, root);
  if (language === "hcl") return hclReviewCandidates(file, root);
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
                : language === "csharp" && node.type === "operator_declaration"
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
            annotationText(file.content, node),
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
              : language === "php" && kind === "test_hook" && scopes.length > 0
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
  if (language === "javascript" || language === "typescript") {
    return specializeEcmascriptCandidates(file, language, root, candidates);
  }
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
          node.endIndex <= first.startIndex || node.startIndex >= last.endIndex,
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

/** Connects same-file and external dependencies between raw candidates. */
function connectDependencies(
  source: string,
  language: TreeSitterLanguage,
  candidates: ReturnType<typeof declarationCandidates>,
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
  for (const candidate of candidates) {
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
        if (statement?.type !== "local_variable_declaration") {
          continue;
        }
        const alias = luaVariableName(source, statement);
        const specifier = luaRequireSpec(source, statement);
        if (alias && specifier) imports.set(alias, `lua-require:${specifier}`);
      }
      for (const variable of syntaxDescendants(candidate.node).filter(
        (node) => node.type === "variable",
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
        if (targets?.length === 1 && targets[0] !== candidate.unit.stableKey) {
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
        if (targets?.length === 1 && targets[0] !== candidate.unit.stableKey) {
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
            if (reference.startsWith("-") || reference.includes("=")) continue;
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
        if (targets?.length === 1 && targets[0] !== candidate.unit.stableKey) {
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
        if (targets?.length === 1 && targets[0] !== candidate.unit.stableKey) {
          dependencies.add(targets[0] as string);
        } else if (!targets) {
          dependencies.add(`${candidate.unit.path}:${reference}`);
        }
      }
    }
    for (const child of candidates) {
      if (
        child.node.parent &&
        child.node.startIndex >= candidate.node.startIndex &&
        child.node.endIndex <= candidate.node.endIndex &&
        child.unit.stableKey !== candidate.unit.stableKey
      ) {
        dependencies.add(child.unit.stableKey);
      }
      if (
        language === "go" &&
        candidate.unit.kind === "class" &&
        child.unit.name.startsWith(`${candidate.ownName}.`) &&
        child.unit.stableKey !== candidate.unit.stableKey
      ) {
        dependencies.add(child.unit.stableKey);
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
        ["autoload", "load", "require", "require_relative"].includes(name ?? "")
      ) {
        return false;
      }
    }
    if (
      language === "lua" &&
      (node.type === "local_variable_declaration" || node.type === "call")
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
          (shape.containers.has(descendant.type) ||
            shape.functions.has(descendant.type) ||
            shape.variables.has(descendant.type) ||
            shape.moduleUnits?.has(descendant.type)) &&
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
      shape.containers.has(ancestor.type) ||
      shape.functions.has(ancestor.type) ||
      shape.variables.has(ancestor.type) ||
      Boolean(shape.moduleUnits?.has(ancestor.type)) ||
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

/** Creates a complete tree-sitter-backed language adapter. */
export function treeSitterAdapter(
  language: TreeSitterLanguage,
  options?: Pick<LanguageAdapter, "matches">,
): LanguageAdapter {
  return {
    language,
    extensions: supportedExtensions[language],
    fileNames: supportedFileNames[language as keyof typeof supportedFileNames],
    matches: options?.matches,
    isContextOnly(source) {
      return withSyntaxTree(
        language,
        source,
        (tree) => meaningfulNodes(language, tree.rootNode, source).length === 0,
      );
    },
    analyze(file) {
      const units = withSyntaxTree(language, file.content, (tree) => {
        const candidates = declarationCandidates(file, language, tree.rootNode);
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
