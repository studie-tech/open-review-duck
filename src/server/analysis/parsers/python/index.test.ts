import { describe, expect, it } from "vitest";
import { analyzeFiles, reconcileSignOffs } from "../../engine";

describe("Python review analysis", () => {
  it("extracts logical declarations without repeating complete class bodies", () => {
    const result = analyzeFiles([
      {
        path: "src/acme/models.py",
        content: [
          '"""Domain types."""',
          "from dataclasses import dataclass",
          "from typing import Final",
          "",
          "DEFAULT_TIMEOUT: Final[int] = 30",
          "cache = build_cache()",
          "normalize = lambda value: value.strip()",
          "type UserId = int",
          "",
          "@dataclass",
          "class Service(BaseService):",
          '    """Coordinates saving."""',
          "    MODE: Final[str] = 'safe'",
          "    timeout: int = 30",
          "    repository: Repository",
          "    if TYPE_CHECKING:",
          "        repository_type = Repository",
          "",
          "    @trace",
          "    async def save(self, value: str):",
          '        """Persist one value."""',
          "        return await self.repository.save(normalize(value))",
        ].join("\n"),
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "DEFAULT_TIMEOUT", kind: "constant" }),
        expect.objectContaining({ name: "cache", kind: "variable" }),
        expect.objectContaining({ name: "normalize", kind: "function" }),
        expect.objectContaining({ name: "UserId", kind: "variable" }),
        expect.objectContaining({ name: "Service.MODE", kind: "constant" }),
        expect.objectContaining({ name: "Service.timeout", kind: "variable" }),
        expect.objectContaining({
          name: "Service.repository",
          kind: "variable",
        }),
        expect.objectContaining({
          name: "Service class statements",
          kind: "module",
          source: expect.stringContaining("if TYPE_CHECKING"),
        }),
        expect.objectContaining({ name: "save", kind: "method" }),
      ]),
    );
    const service = reviewable.find(({ name }) => name === "Service");
    expect(service).toMatchObject({ kind: "class" });
    expect(service?.source).toContain("@dataclass");
    expect(service?.source).toContain('"""Coordinates saving."""');
    expect(service?.source).not.toContain("MODE");
    expect(service?.source).not.toContain("async def save");
    expect(reviewable.find(({ name }) => name === "save")?.source).toContain(
      '"""Persist one value."""',
    );
    const repository = reviewable.find(
      ({ name }) => name === "Service.repository",
    );
    const save = reviewable.find(({ name }) => name === "save");
    expect(save?.dependencies).toContain(repository?.stableKey);
    expect(service?.dependencies).toEqual(
      expect.arrayContaining([
        repository?.stableKey,
        save?.stableKey,
        reviewable.find(({ name }) => name === "Service.MODE")?.stableKey,
        reviewable.find(({ name }) => name === "Service.timeout")?.stableKey,
        reviewable.find(({ name }) => name === "Service class statements")
          ?.stableKey,
      ]),
    );
    expect(service?.reviewOrder).toBeGreaterThan(save?.reviewOrder ?? -1);
    expect(
      reviewable
        .filter(({ kind }) => kind === "module")
        .map(({ name }) => name),
    ).toEqual(["Service class statements"]);
  });

  it("keeps module docstrings and imports as context rather than review units", () => {
    const result = analyzeFiles([
      {
        path: "src/acme/__init__.py",
        content: [
          '"""Public package exports."""',
          "from .models import (Service, UserId)",
          "import os, sys",
        ].join("\n"),
      },
    ]);

    expect(result.units.filter(({ kind }) => kind !== "file")).toEqual([]);
  });

  it("resolves named, module, local, and src-layout imports", () => {
    const result = analyzeFiles([
      {
        path: "src/acme/helpers.py",
        content: [
          "def normalize(value):",
          "    return value.strip()",
          "",
          "def validate(value):",
          "    return bool(value)",
        ].join("\n"),
      },
      {
        path: "src/acme/service.py",
        content: [
          "import acme.helpers as helpers",
          "from .helpers import validate as is_valid",
          "",
          "def save(value):",
          "    if not is_valid(value):",
          "        raise ValueError(value)",
          "    return helpers.normalize(value)",
        ].join("\n"),
      },
      {
        path: "src/acme/local_service.py",
        content: [
          "from . import helpers as local_helpers",
          "",
          "def load(value):",
          "    return local_helpers.normalize(value)",
        ].join("\n"),
      },
    ]);
    const normalize = result.units.find(
      ({ path, name }) =>
        path === "src/acme/helpers.py" && name === "normalize",
    );
    const validate = result.units.find(
      ({ path, name }) => path === "src/acme/helpers.py" && name === "validate",
    );
    const save = result.units.find(({ name }) => name === "save");
    const load = result.units.find(({ name }) => name === "load");

    expect(save?.dependencies).toEqual(
      expect.arrayContaining([normalize?.stableKey, validate?.stableKey]),
    );
    expect(load?.dependencies).toContain(normalize?.stableKey);
    expect(save?.reviewOrder).toBeGreaterThan(normalize?.reviewOrder ?? -1);
    expect(load?.reviewOrder).toBeGreaterThan(normalize?.reviewOrder ?? -1);
  });

  it("finishes one independent Python concept before starting another", () => {
    const result = analyzeFiles([
      {
        path: "src/features.py",
        content: [
          "def alpha_leaf(): return 'alpha'",
          "def alpha_middle(): return alpha_leaf()",
          "def alpha_feature(): return alpha_middle()",
          "def beta_leaf(): return 'beta'",
          "def beta_middle(): return beta_leaf()",
          "def beta_feature(): return beta_middle()",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind === "function")
        .map(({ name }) => name),
    ).toEqual([
      "alpha_leaf",
      "alpha_middle",
      "alpha_feature",
      "beta_leaf",
      "beta_middle",
      "beta_feature",
    ]);
  });

  it("splits Python tests while grouping conventional lifecycle methods", () => {
    const result = analyzeFiles([
      {
        path: "tests/test_service.py",
        content: [
          '"""Service behavior."""',
          "import pytest",
          "import unittest",
          "from acme.service import Service",
          "",
          "pytestmark = pytest.mark.unit",
          "",
          "@pytest.fixture",
          "def service():",
          "    return Service()",
          "",
          "def test_health(service):",
          "    assert service.health()",
          "",
          "class TestService(unittest.TestCase):",
          "    def setUp(self):",
          "        self.service = Service()",
          "",
          "    def tearDown(self):",
          "        self.service.close()",
          "",
          "    def test_save(self):",
          "        self.assertTrue(self.service.save())",
        ].join("\n"),
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable.some(({ name }) => name === "Test setup")).toBe(false);
    expect(reviewable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "pytestmark", kind: "variable" }),
        expect.objectContaining({ name: "service", kind: "test_hook" }),
        expect.objectContaining({ name: "test_health", kind: "test" }),
        expect.objectContaining({
          name: "TestService › Test lifecycle",
          kind: "test_hook",
          source: expect.stringContaining("def tearDown"),
        }),
        expect.objectContaining({
          name: "TestService › test_save",
          kind: "test",
        }),
      ]),
    );
    expect(reviewable.some(({ name }) => name === "TestService")).toBe(false);
    expect(reviewable.some(({ name }) => name.endsWith("setUp"))).toBe(false);
    expect(reviewable.some(({ name }) => name.endsWith("tearDown"))).toBe(
      false,
    );
  });

  it("groups executable test-module setup without turning imports into units", () => {
    const result = analyzeFiles([
      {
        path: "tests/test_bootstrap.py",
        content: [
          "import pytest",
          "from acme.bootstrap import configure",
          "",
          "configure()",
          "install_test_clock()",
          "",
          "def test_ready():",
          "    assert ready()",
        ].join("\n"),
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(
      reviewable.find(({ name }) => name === "Test module setup"),
    ).toMatchObject({
      startLine: 4,
      endLine: 5,
      source: "configure()\ninstall_test_clock()",
    });
    expect(
      reviewable.some(({ source }) => source.trim().startsWith("import ")),
    ).toBe(false);
    expect(reviewable.find(({ name }) => name === "test_ready")).toMatchObject({
      kind: "test",
    });
  });

  it("does not mistake production lifecycle-named methods for test hooks", () => {
    const result = analyzeFiles([
      {
        path: "src/plugin.py",
        content: [
          "class Plugin:",
          "    def setup_method(self):",
          "        self.ready = True",
        ].join("\n"),
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "setup_method"),
    ).toMatchObject({ kind: "method" });
  });

  it("treats docstring changes as reviewable semantic changes", () => {
    const before = analyzeFiles([
      {
        path: "src/service.py",
        content: 'def save():\n    """Save a value."""\n    return True\n',
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "src/service.py",
        content:
          'def save():\n    """Persist a validated value."""\n    return True\n',
      },
    ]).units;

    expect(
      reconcileSignOffs(before, after).find(({ unit }) => unit.name === "save")
        ?.requiresReview,
    ).toBe(true);
  });

  it("keeps unchanged Python consumers signed off after a constant changes", () => {
    const before = analyzeFiles([
      {
        path: "src/retry.py",
        content: [
          "from typing import Final",
          "MAX_RETRIES: Final[int] = 3",
          "def should_retry(attempt): return attempt < MAX_RETRIES",
        ].join("\n"),
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "src/retry.py",
        content: [
          "from typing import Final",
          "MAX_RETRIES: Final[int] = 5",
          "def should_retry(attempt): return attempt < MAX_RETRIES",
        ].join("\n"),
      },
    ]).units;

    expect(
      reconcileSignOffs(before, after).find(
        ({ unit }) => unit.name === "should_retry",
      )?.requiresReview,
    ).toBe(false);
  });
});
