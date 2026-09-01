import { describe, expect, it } from "vitest";
import { resolveRulebooks, rulebookCorpusDigest } from "./rulebooks";
import { RULEBOOK_PATTERNS } from "./rulebooks/corpus.generated";

describe("deep review rulebook resolution", () => {
  it("matches a repository-root file, because ** spans zero segments", () => {
    expect(resolveRulebooks("main.go").primary).toBe("go.md");
    expect(resolveRulebooks("src/server/main.go").primary).toBe("go.md");
  });

  it("prefers the workflow rulebook over the general YAML one", () => {
    const workflow = resolveRulebooks(".github/workflows/ci.yml");
    expect(workflow.primary).toBe("github_workflows.md");
    expect(workflow.secondary).toBe("yaml.md");
  });

  it("keeps the authored pattern order, so .github config beats plain YAML", () => {
    expect(resolveRulebooks(".github/dependabot.yml").primary).toBe(
      "github_config.md",
    );
    expect(resolveRulebooks("deploy/values.yml").primary).toBe("yaml.md");
  });

  it("resolves a named file ahead of its extension and keeps both", () => {
    const manifest = resolveRulebooks("package.json");
    expect(manifest.primary).toBe("package_json.md");
    expect(manifest.secondary).toBe("json.md");
  });

  it("leaves the secondary slot empty when the extension rulebook won", () => {
    const source = resolveRulebooks("src/index.ts");
    expect(source.primary).toBe("ts_js_tsx_jsx.md");
    expect(source.secondary).toBeNull();
  });

  it("expands brace alternation and infix wildcards", () => {
    expect(resolveRulebooks("src/App.tsx").primary).toBe("ts_js_tsx_jsx.md");
    expect(resolveRulebooks("main.cc").primary).toBe("cpp.md");
    expect(resolveRulebooks("conf/UserMapper.xml").primary).toBe(
      "mapper_dao_xml.md",
    );
  });

  it("matches case-insensitively, as upstream does by lowercasing both sides", () => {
    expect(resolveRulebooks("src/Main.GO").primary).toBe("go.md");
    expect(resolveRulebooks("POM.XML").primary).toBe("pom_xml.md");
  });

  it("falls back to the default rulebook for an unmatched path", () => {
    const unmatched = resolveRulebooks("docs/architecture.adoc");
    expect(unmatched.primary).toBe("default.md");
    expect(unmatched.secondary).toBeNull();
  });

  it("normalizes separators and leading path noise", () => {
    expect(resolveRulebooks("./src/main.rs").primary).toBe("rust.md");
    expect(resolveRulebooks("/src/main.rs").primary).toBe("rust.md");
    expect(resolveRulebooks("src\\main.rs").primary).toBe("rust.md");
  });

  it("returns concatenated rulebook text for every resolved name", () => {
    const workflow = resolveRulebooks(".github/workflows/release.yaml");
    expect(workflow.names).toEqual(["github_workflows.md", "yaml.md"]);
    expect(workflow.text.length).toBeGreaterThan(0);
  });

  it("compiles every vendored pattern without throwing", () => {
    for (const [pattern] of RULEBOOK_PATTERNS) {
      expect(() => resolveRulebooks(`probe/${pattern}`)).not.toThrow();
    }
  });

  it("exposes a stable corpus digest", () => {
    expect(rulebookCorpusDigest()).toMatch(/^[0-9a-f]{64}$/);
  });
});
