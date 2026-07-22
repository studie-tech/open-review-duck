import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { javaAdapter } from ".";

/** Runs the Java adapter against an in-memory source file. */
function analyze(content: string, path = "src/main/java/acme/Service.java") {
  return javaAdapter.analyze({ path, content } satisfies SourceFile);
}

describe("Java review parser", () => {
  it("extracts documented type shells, fields, initializers, constructors, methods, and nested types", () => {
    const units = analyze(
      [
        "package acme;",
        "",
        "import java.util.List;",
        "import jakarta.inject.Inject;",
        "",
        "/** Coordinates persistence. */",
        '@Deprecated(since = "2")',
        "public final class Service<T extends Entity> implements Store<T> {",
        "  /** Default request limit. */",
        "  public static final int DEFAULT_LIMIT = 25;",
        "",
        "  @Inject",
        "  private Repository<T> repository;",
        "",
        "  static { Registry.register(Service.class); }",
        "  { validateEnvironment(); }",
        "",
        "  /** Creates a service. */",
        "  public Service(Repository<T> repository) {",
        "    this.repository = repository;",
        "  }",
        "",
        "  /** Persists all values. */",
        "  @Override",
        "  public <R extends Result> R save(",
        "      List<T> values,",
        "      Mapper<T, R> mapper",
        "  ) throws StoreException {",
        "    return mapper.map(repository.save(values), DEFAULT_LIMIT);",
        "  }",
        "",
        "  /** Pagination coordinates. */",
        "  public record Cursor(long offset, int limit) {",
        "    public boolean exhausted() { return limit == 0; }",
        "  }",
        "}",
      ].join("\n"),
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Service.DEFAULT_LIMIT",
          kind: "constant",
          source: expect.stringContaining("Default request limit"),
        }),
        expect.objectContaining({
          name: "Service.repository",
          kind: "variable",
          source: expect.stringContaining("@Inject"),
        }),
        expect.objectContaining({
          name: "Service static initializer",
          kind: "module",
        }),
        expect.objectContaining({
          name: "Service instance initializer",
          kind: "module",
        }),
        expect.objectContaining({
          name: "Service constructor",
          kind: "method",
          source: expect.stringContaining("Creates a service"),
        }),
        expect.objectContaining({
          name: "save",
          kind: "method",
          source: expect.stringContaining("Persists all values"),
        }),
        expect.objectContaining({ name: "Cursor", kind: "class" }),
        expect.objectContaining({ name: "exhausted", kind: "method" }),
      ]),
    );

    const service = units.find(({ name }) => name === "Service");
    const cursor = units.find(({ name }) => name === "Cursor");
    const save = units.find(({ name }) => name === "save");
    const repository = units.find(({ name }) => name === "Service.repository");
    expect(service).toMatchObject({ kind: "class", startLine: 6, endLine: 8 });
    expect(service?.source).toContain("Coordinates persistence");
    expect(service?.source).not.toContain("DEFAULT_LIMIT");
    expect(service?.source).not.toContain("R save");
    expect(service?.dependencies).toEqual(
      expect.arrayContaining([
        repository?.stableKey,
        save?.stableKey,
        cursor?.stableKey,
      ]),
    );
    expect(save?.dependencies).toContain(repository?.stableKey);
    expect(cursor?.source).toContain("Pagination coordinates");
    expect(cursor?.source).not.toContain("exhausted");
  });

  it("supports interfaces, annotation declarations, records, enums, and compact constructors", () => {
    const units = analyze(
      [
        "package acme.model;",
        "",
        "public interface Identified<T> {",
        "  T id();",
        "  default boolean valid() { return id() != null; }",
        "}",
        "",
        "@java.lang.annotation.Retention(RUNTIME)",
        "public @interface Audited {",
        '  String value() default "write";',
        "}",
        "",
        "public record Point(int x, int y) implements Identified<Integer> {",
        "  public Point {",
        "    if (x < 0) throw new IllegalArgumentException();",
        "  }",
        "  public Integer id() { return x; }",
        "}",
        "",
        "public enum State {",
        "  NEW,",
        '  ACTIVE(1) { @Override public String toString() { return "active}"; } },',
        "  CLOSED;",
        "  private final int code = 0;",
        "  State() {}",
        "  State(int code) { this.code = code; }",
        "}",
      ].join("\n"),
      "src/main/java/acme/model/Types.java",
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Identified", kind: "class" }),
        expect.objectContaining({ name: "id", kind: "method" }),
        expect.objectContaining({ name: "valid", kind: "method" }),
        expect.objectContaining({ name: "Audited", kind: "class" }),
        expect.objectContaining({ name: "Point", kind: "class" }),
        expect.objectContaining({ name: "Point constructor", kind: "method" }),
        expect.objectContaining({ name: "State.NEW", kind: "constant" }),
        expect.objectContaining({ name: "State.ACTIVE", kind: "constant" }),
        expect.objectContaining({ name: "State.CLOSED", kind: "constant" }),
        expect.objectContaining({ name: "State.code", kind: "variable" }),
      ]),
    );
    expect(
      units.filter(({ name }) => name === "State constructor"),
    ).toHaveLength(2);
  });

  it("extracts JUnit and TestNG tests and lifecycle hooks with suite context", () => {
    const units = analyze(
      [
        "package acme;",
        "",
        "import org.junit.jupiter.api.*;",
        "import org.testng.annotations.BeforeSuite;",
        "",
        "@TestInstance(TestInstance.Lifecycle.PER_CLASS)",
        "class ServiceTest {",
        "  @BeforeAll",
        "  void openDatabase() { database.open(); }",
        "",
        "  @BeforeEach",
        "  void reset() { database.reset(); }",
        "",
        '  @ParameterizedTest(name = "case {0}")',
        '  @ValueSource(strings = {"a", "b"})',
        "  void savesValues(String value) { assertTrue(service.save(value)); }",
        "",
        "  @org.testng.annotations.Test",
        '  public void rejectsInvalidValues() { assertThrows(Exception.class, () -> service.save("}")); }',
        "",
        "  @BeforeSuite",
        "  public void prepareSuite() {}",
        "}",
      ].join("\n"),
      "src/test/java/acme/ServiceTest.java",
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ServiceTest",
          kind: "test_suite",
        }),
        expect.objectContaining({
          name: "ServiceTest › openDatabase",
          kind: "test_hook",
        }),
        expect.objectContaining({
          name: "ServiceTest › reset",
          kind: "test_hook",
        }),
        expect.objectContaining({
          name: "ServiceTest › savesValues",
          kind: "test",
          source: expect.stringContaining("@ParameterizedTest"),
        }),
        expect.objectContaining({
          name: "ServiceTest › rejectsInvalidValues",
          kind: "test",
        }),
        expect.objectContaining({
          name: "ServiceTest › prepareSuite",
          kind: "test_hook",
        }),
      ]),
    );
  });

  it("keeps package declarations and imports as context instead of review units", () => {
    expect(
      analyze(
        [
          "package acme;",
          "import java.util.List;",
          "import static org.junit.jupiter.api.Assertions.*;",
        ].join("\n"),
        "src/main/java/acme/package-info.java",
      ),
    ).toEqual([]);
  });

  it("does not confuse calls, lambdas, anonymous classes, strings, or comments for declarations", () => {
    const units = analyze(
      [
        "class Robust {",
        "  // fake() { and class Noise {",
        '  private Supplier<String> supplier = () -> "not a } declaration";',
        "  private Runnable runner = new Runnable() {",
        '    @Override public void run() { System.out.println("{"); }',
        "  };",
        "  private int[] values = new int[] { 1, 2, 3 };",
        '  String text() { return "class Fake { void nope() {} }"; }',
        "}",
      ].join("\n"),
    );

    expect(units.filter(({ kind }) => kind === "variable")).toHaveLength(3);
    expect(units.filter(({ kind }) => kind === "method")).toHaveLength(1);
    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Robust.supplier" }),
        expect.objectContaining({ name: "Robust.runner" }),
        expect.objectContaining({ name: "Robust.values" }),
        expect.objectContaining({ name: "text", kind: "method" }),
      ]),
    );
  });
});
