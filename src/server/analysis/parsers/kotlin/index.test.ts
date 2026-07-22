import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { isContextOnly, kotlinAdapter, kotlinParserInternals } from ".";

/** Analyzes an in-memory Kotlin fixture with a representative source path. */
function analyze(content: string, path = "src/main/kotlin/acme/Service.kt") {
  return kotlinAdapter.analyze({ path, content, changeType: "added" });
}

/** Finds a fixture unit by display name and reports useful failure context. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected ${name}; received ${units.map(({ kind, name: unitName }) => `${kind}:${unitName}`).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing ${name}`);
  return unit;
}

describe("Kotlin review analysis", () => {
  it("extracts KDoc, type shells, properties, init, constructors, members, and nested types", () => {
    const units = analyze(`package acme

import kotlinx.coroutines.Dispatchers

/** Coordinates durable persistence. */
@Deprecated("Use Store")
sealed class Service<T>(
  private val repository: Repository<T>,
) where T : Entity {
  /** Default request limit. */
  companion object {
    const val DEFAULT_LIMIT = 25
  }

  val dispatcher by lazy { Dispatchers.IO }

  init {
    require(DEFAULT_LIMIT > 0)
  }

  constructor(repository: Repository<T>, eager: Boolean) : this(repository) {
    if (eager) warmUp()
  }

  /** Saves one value. */
  suspend fun save(value: T): Result<T> {
    return repository.save(value)
  }

  data class Cursor(val offset: Long, val limit: Int) {
    fun exhausted(): Boolean = limit == 0
  }
}
`);

    expect(kotlinAdapter.extensions).toEqual(
      expect.arrayContaining([".kt", ".kts"]),
    );
    const service = named(units, "Service");
    expect(service.kind).toBe("class");
    expect(service.source).toContain("Coordinates durable persistence");
    expect(service.source).not.toContain("suspend fun save");
    expect(named(units, "Service.Companion").kind).toBe("class");
    expect(named(units, "Service.Companion.DEFAULT_LIMIT").kind).toBe(
      "constant",
    );
    expect(named(units, "Service.dispatcher").kind).toBe("variable");
    expect(named(units, "Service init block").kind).toBe("method");
    expect(named(units, "Service constructor").kind).toBe("method");
    const save = named(units, "Service.save");
    expect(save.kind).toBe("method");
    expect(save.source).toContain("Saves one value");
    expect(named(units, "Service.Cursor").kind).toBe("class");
    expect(named(units, "Service.Cursor.exhausted").kind).toBe("method");
    expect(service.dependencies).toEqual(
      expect.arrayContaining([
        save.stableKey,
        named(units, "Service.Cursor").stableKey,
      ]),
    );
  });

  it("supports interfaces, objects, value classes, enums, typealiases, extensions, and named lambdas", () => {
    const units = analyze(`typealias UserId = String

interface Identified {
  val id: UserId
  fun valid(): Boolean
}

@JvmInline
value class Email(val value: String)

enum class State { NEW, ACTIVE, CLOSED }

object Slugs {
  fun normalize(value: String) = value.trim().lowercase()
}

/** Converts text into a stable slug. */
fun String.toSlug(): String = Slugs.normalize(this)

val handleMessage: (String) -> String = { value ->
  value.toSlug()
}
`);
    expect(named(units, "UserId").kind).toBe("class");
    expect(named(units, "Identified").kind).toBe("class");
    expect(named(units, "Email").kind).toBe("class");
    expect(named(units, "State").kind).toBe("class");
    expect(named(units, "Slugs").kind).toBe("class");
    const extension = named(units, "String.toSlug");
    expect(extension.kind).toBe("function");
    expect(extension.source).toContain("Converts text");
    expect(extension.dependencies).toContain(
      named(units, "Slugs.normalize").stableKey,
    );
    expect(named(units, "handleMessage").kind).toBe("function");
  });

  it("classifies annotated JUnit tests, coroutine tests, and lifecycle fixtures", () => {
    const units = analyze(
      `class ServiceTest {
  @BeforeEach
  fun reset() { service.reset() }

  @Test
  fun savesValue() = runTest {
    assertTrue(service.save("value"))
  }

  @ParameterizedTest
  @ValueSource(strings = ["a", "b"])
  fun rejectsBlank(value: String) {
    assertFails { service.save(value) }
  }

  @AfterEach
  fun close() { service.close() }
}
`,
      "src/test/kotlin/acme/ServiceTest.kt",
    );
    expect(named(units, "ServiceTest").kind).toBe("test_suite");
    expect(named(units, "ServiceTest › reset").kind).toBe("test_hook");
    expect(named(units, "ServiceTest › savesValue").kind).toBe("test");
    expect(named(units, "ServiceTest › savesValue").source).toContain(
      "runTest",
    );
    expect(named(units, "ServiceTest › rejectsBlank").kind).toBe("test");
    expect(named(units, "ServiceTest › close").kind).toBe("test_hook");
  });

  it("extracts nested Kotest and Spek-style DSL tests and hooks", () => {
    const units = analyze(
      `class DeliverySpec : FunSpec({
  beforeTest { service.reset() }

  context("when online") {
    test("publishes a message") {
      service.publish("hello")
    }

    test("records metrics") {
      service.publish("hello")
      service.metrics()
    }
  }

  afterTest { service.close() }
})

object ValidationSpek : Spek({
  describe("an identifier") {
    it("rejects blanks") { require(validate(" ")) }
  }
})
`,
      "src/test/kotlin/acme/DeliverySpec.kt",
    );
    expect(named(units, "DeliverySpec › before test").kind).toBe("test_hook");
    const publish = named(
      units,
      "DeliverySpec › when online › publishes a message",
    );
    expect(publish.kind).toBe("test");
    expect(publish.source).not.toContain("records metrics");
    expect(
      named(units, "DeliverySpec › when online › records metrics").kind,
    ).toBe("test");
    expect(named(units, "DeliverySpec › after test").kind).toBe("test_hook");
    expect(
      named(units, "ValidationSpek › an identifier › rejects blanks").kind,
    ).toBe("test");
  });

  it("keeps raw strings, templates, chars, comments, and object expressions structurally opaque", () => {
    const content = `/* class Fake { fun hidden() {} } */
val TEMPLATE = """
  class AlsoFake {
    fun nope() = "}"
  }
""".trimIndent()

val closeBrace = '}'
val strategy = object : Strategy {
  override fun apply(value: String) = value
}

fun real(input: String): String {
  val text = "value=\${input} and brace }"
  return text
}
`;
    const units = analyze(content);
    expect(units.some(({ name }) => name.includes("Fake"))).toBe(false);
    expect(units.some(({ name }) => name === "nope")).toBe(false);
    expect(named(units, "TEMPLATE").kind).toBe("constant");
    expect(named(units, "strategy").kind).toBe("variable");
    expect(named(units, "real").source).toContain("brace }");
    expect(
      kotlinParserInternals
        .tokenizeKotlin(content)
        .some(({ value }) => value === "AlsoFake"),
    ).toBe(false);
  });

  it("recognizes package/import-only preambles and reviews executable scripts", () => {
    const context = `/** Module package. */
package acme.delivery

import kotlinx.coroutines.*
import acme.Store as DurableStore
`;
    expect(isContextOnly(context)).toBe(true);
    expect(
      kotlinAdapter.analyze({
        path: "src/main/kotlin/acme/package.kt",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(isContextOnly('println("ready")')).toBe(false);
    expect(
      named(
        analyze('println("ready")', "build.gradle.kts"),
        "Kotlin module statements",
      ).kind,
    ).toBe("module");
  });

  it("keeps nested local functions with their owning function instead of duplicating them", () => {
    const units = analyze(`fun outer(value: String): String {
  fun normalize(item: String) = item.trim()
  return normalize(value)
}
`);
    expect(named(units, "outer").source).toContain("fun normalize");
    expect(units.some(({ name }) => name === "normalize")).toBe(false);
  });
});
