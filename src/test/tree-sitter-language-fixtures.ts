import type { TreeSitterLanguage } from "~/server/analysis/tree-sitter";

interface LanguageFixture {
  path: string;
  source: string;
}

export const treeSitterLanguageFixtures = {
  javascript: {
    path: "src/duck.js",
    source: 'export function quack() { return "duck"; }',
  },
  typescript: {
    path: "src/duck.ts",
    source:
      "export interface Duck { sound: string }\nexport function quack(duck: Duck) { return duck.sound; }",
  },
  python: {
    path: "src/duck.py",
    source: 'class Duck:\n    def quack(self):\n        return "duck"',
  },
  java: {
    path: "src/Duck.java",
    source: 'class Duck { String quack() { return "duck"; } }',
  },
  csharp: {
    path: "src/Duck.cs",
    source: 'class Duck { string Quack() { return "duck"; } }',
  },
  cpp: {
    path: "src/duck.cpp",
    source: 'class Duck { public: const char* quack() { return "duck"; } };',
  },
  php: {
    path: "src/duck.php",
    source: '<?php function quack(): string { return "duck"; }',
  },
  shell: {
    path: "scripts/duck.sh",
    source: 'quack() { printf "%s\\n" "duck"; }',
  },
  c: {
    path: "src/duck.c",
    source: 'const char *quack(void) { return "duck"; }',
  },
  ruby: {
    path: "lib/duck.rb",
    source: 'class Duck\n  def quack\n    "duck"\n  end\nend',
  },
  hcl: {
    path: "infra/duck.tf",
    source: 'resource "example_duck" "main" {\n  sound = "quack"\n}',
  },
  rust: {
    path: "src/duck.rs",
    source: 'struct Duck;\nimpl Duck { fn quack(&self) -> &str { "duck" } }',
  },
  lua: {
    path: "src/duck.lua",
    source: 'local function quack()\n  return "duck"\nend',
  },
  go: {
    path: "src/duck.go",
    source: 'package duck\nfunc Quack() string { return "duck" }',
  },
  makefile: {
    path: "Makefile",
    source: "duck:\n\t@echo quack\n",
  },
  kotlin: {
    path: "src/Duck.kt",
    source:
      'class Duck {\n  fun quack(): String {\n    return "duck"\n  }\n}\n',
  },
  css: {
    path: "styles/duck.css",
    source: ".duck { color: teal; }",
  },
  dart: {
    path: "lib/duck.dart",
    source: 'class Duck { String quack() => "duck"; }',
  },
  elisp: {
    path: "lisp/duck.el",
    source: '(defun quack () "duck")',
  },
  elixir: {
    path: "lib/duck.ex",
    source: "defmodule Duck do\n  def quack, do: :duck\nend",
  },
  elm: {
    path: "src/Duck.elm",
    source: 'module Duck exposing (quack)\nquack = "duck"',
  },
  embedded_template: {
    path: "views/duck.erb",
    source: "<section><%= duck.sound %></section>",
  },
  html: {
    path: "public/duck.html",
    source: "<main><h1>Duck</h1></main>",
  },
  json: {
    path: "config/duck.json",
    source: '{"duck":{"sound":"quack"}}',
  },
  objc: {
    path: "src/Duck.m",
    source:
      '@interface Duck\n- (NSString *)quack;\n@end\n@implementation Duck\n- (NSString *)quack { return @"duck"; }\n@end',
  },
  ocaml: {
    path: "lib/duck.ml",
    source: 'module Duck = struct\n  let quack () = "duck"\nend',
  },
  ql: {
    path: "queries/duck.ql",
    source:
      'import javascript\nfrom Function f\nwhere f.getName() = "quack"\nselect f',
  },
  rescript: {
    path: "src/Duck.res",
    source: 'module Duck = { let quack = () => "duck" }',
  },
  scala: {
    path: "src/Duck.scala",
    source: 'class Duck { def quack(): String = "duck" }',
  },
  solidity: {
    path: "contracts/Duck.sol",
    source:
      'contract Duck { function quack() public pure returns (string memory) { return "duck"; } }',
  },
  swift: {
    path: "Sources/Duck.swift",
    source: 'class Duck { func quack() -> String { "duck" } }',
  },
  systemrdl: {
    path: "registers/duck.rdl",
    source: "addrmap Duck { reg { field {} sound; } quack; };",
  },
  tlaplus: {
    path: "spec/Duck.tla",
    source: "---- MODULE Duck ----\nQuack == TRUE\n====",
  },
  toml: {
    path: "config/duck.toml",
    source: '[duck]\nsound = "quack"',
  },
  vue: {
    path: "src/Duck.vue",
    source:
      '<script setup>const sound = "quack"</script>\n<template><p>{{ sound }}</p></template>',
  },
  yaml: {
    path: "config/duck.yaml",
    source: "duck:\n  sound: quack",
  },
  zig: {
    path: "src/duck.zig",
    source: 'const Duck = struct { fn quack() []const u8 { return "duck"; } };',
  },
  sql: {
    path: "db/duck.sql",
    source:
      "CREATE TABLE duck (id INTEGER, sound TEXT);\nCREATE INDEX duck_sound ON duck(sound);",
  },
  markdown: {
    path: "docs/duck.md",
    source: "# Duck\n\nA duck says **quack**.",
  },
  mdx: {
    path: "docs/duck.mdx",
    source: '# Duck\n\n<Duck sound="quack" />',
  },
  dockerfile: {
    path: "Dockerfile",
    source: "FROM node:24-alpine\nRUN echo quack\n",
  },
  graphql: {
    path: "schema/duck.graphql",
    source: "type Duck { sound: String! }\nquery Ducks { ducks { sound } }",
  },
  prisma: {
    path: "prisma/schema.prisma",
    source: "model Duck {\n  id Int @id\n  sound String\n}",
  },
  protobuf: {
    path: "proto/duck.proto",
    source: 'syntax = "proto3";\nmessage Duck { string sound = 1; }',
  },
  xml: {
    path: "data/duck.xml",
    source: "<duck><sound>quack</sound></duck>",
  },
  scss: {
    path: "styles/duck.scss",
    source: "$duck-color: teal;\n.duck { color: $duck-color; }",
  },
  svelte: {
    path: "src/Duck.svelte",
    source: '<script>const sound = "quack";</script>\n<h1>{sound}</h1>',
  },
  astro: {
    path: "src/pages/duck.astro",
    source: '---\nconst sound = "quack";\n---\n<h1>{sound}</h1>',
  },
  r: {
    path: "R/duck.r",
    source: 'quack <- function() { "duck" }',
  },
  julia: {
    path: "src/Duck.jl",
    source: "struct Duck\n  sound::String\nend\nquack(duck::Duck) = duck.sound",
  },
  haskell: {
    path: "src/Duck.hs",
    source:
      "module Duck where\ndata Duck = Duck String\nquack (Duck sound) = sound",
  },
  clojure: {
    path: "src/duck/core.clj",
    source: '(ns duck.core)\n(defn quack [] "duck")',
  },
  erlang: {
    path: "src/duck.erl",
    source: "-module(duck).\n-export([quack/0]).\nquack() -> duck.",
  },
  fsharp: {
    path: "src/Duck.fs",
    source:
      "module Duck\ntype Duck = { Sound: string }\nlet quack duck = duck.Sound",
  },
  powershell: {
    path: "scripts/duck.ps1",
    source: 'function Quack { return "duck" }\n',
  },
  fortran: {
    path: "src/duck.f90",
    source:
      "module duck\ncontains\nsubroutine quack()\nend subroutine quack\nend module duck",
  },
  perl: {
    path: "lib/Duck.pm",
    source: 'package Duck;\nsub quack { return "duck"; }\n1;',
  },
  groovy: {
    path: "src/Duck.groovy",
    source: 'class Duck { String quack() { return "duck"; } }',
  },
  nix: {
    path: "nix/duck.nix",
    source: '{ pkgs }: { duck = pkgs.writeText "duck" "quack"; }',
  },
  latex: {
    path: "docs/duck.tex",
    source: "\\section{Duck}\nA duck says quack.",
  },
  systemverilog: {
    path: "rtl/duck.sv",
    source: "module duck;\n  function void quack();\n  endfunction\nendmodule",
  },
  assembly: {
    path: "src/duck.s",
    source: ".text\n.global quack\nquack:\n  ret",
  },
} as const satisfies Record<TreeSitterLanguage, LanguageFixture>;
