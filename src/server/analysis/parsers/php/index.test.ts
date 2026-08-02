import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { phpAdapter } from ".";

/** Runs the PHP adapter against an in-memory source file. */
function analyze(content: string, path = "src/Service.php") {
  return phpAdapter.analyze({ path, content } satisfies SourceFile);
}

describe("PHP review parser", () => {
  it("extracts documented types, properties, constants, promoted fields, and methods", () => {
    const units = analyze(
      [
        "<?php",
        "declare(strict_types=1);",
        "namespace Acme\\Billing;",
        "use Acme\\Contracts\\Store;",
        "use Attribute;",
        "",
        "/** Coordinates invoice persistence. */",
        "#[ServiceAttribute(name: 'billing')]",
        "final readonly class InvoiceService implements Store",
        "{",
        "    /** Maximum attempts. */",
        "    public const MAX_ATTEMPTS = 3;",
        "",
        "    #[Inject]",
        "    private Logger&Flushable $logger;",
        "",
        "    /** Creates the service. */",
        "    public function __construct(",
        "        private Repository|CachedRepository $repository,",
        "        protected readonly Clock $clock,",
        "    ) {}",
        "",
        "    /** Saves an invoice. */",
        "    #[Transactional]",
        "    public function save(Invoice $invoice): Result",
        "    {",
        "        $this->logger->info(<<<'MESSAGE'",
        "fake class Noise { function nope() {} }",
        "MESSAGE);",
        "        return $this->repository->save($invoice, self::MAX_ATTEMPTS);",
        "    }",
        "",
        "    public function __invoke(Invoice $invoice): Result",
        "    {",
        "        return $this->save($invoice);",
        "    }",
        "}",
      ].join("\n"),
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "InvoiceService.MAX_ATTEMPTS",
          kind: "constant",
          source: expect.stringContaining("Maximum attempts"),
        }),
        expect.objectContaining({
          name: "InvoiceService.$logger",
          kind: "variable",
          source: expect.stringContaining("#[Inject]"),
        }),
        expect.objectContaining({
          name: "InvoiceService.$repository",
          kind: "variable",
          source: expect.stringContaining(
            "private Repository|CachedRepository",
          ),
        }),
        expect.objectContaining({
          name: "InvoiceService.$clock",
          kind: "variable",
        }),
        expect.objectContaining({
          name: "InvoiceService constructor",
          kind: "method",
        }),
        expect.objectContaining({
          name: "save",
          kind: "method",
          source: expect.stringContaining("Saves an invoice"),
        }),
        expect.objectContaining({ name: "__invoke", kind: "method" }),
      ]),
    );
    const shell = units.find(({ name }) => name === "InvoiceService");
    const repository = units.find(
      ({ name }) => name === "InvoiceService.$repository",
    );
    const maximum = units.find(
      ({ name }) => name === "InvoiceService.MAX_ATTEMPTS",
    );
    const save = units.find(({ name }) => name === "save");
    const invoke = units.find(({ name }) => name === "__invoke");
    expect(shell).toMatchObject({ kind: "class", startLine: 7, endLine: 10 });
    expect(shell?.source).toContain("Coordinates invoice persistence");
    expect(shell?.source).not.toContain("MAX_ATTEMPTS");
    expect(shell?.dependencies).toEqual(
      expect.arrayContaining([repository?.stableKey, save?.stableKey]),
    );
    expect(save?.dependencies).toEqual(
      expect.arrayContaining([repository?.stableKey, maximum?.stableKey]),
    );
    expect(invoke?.dependencies).toContain(save?.stableKey);
    expect(units.some(({ name }) => name.includes("Noise"))).toBe(false);
  });

  it("supports interfaces, traits, enums, closures, arrow functions, and global declarations", () => {
    const units = analyze(
      [
        "<?php",
        "namespace Acme;",
        "",
        "/** Public persistence contract. */",
        "interface Store { public function save(object $value): void; }",
        "trait Audits { protected function audit(): void {} }",
        "enum State: string {",
        "  case Open = 'open';",
        "  case Closed = 'closed';",
        "  public function terminal(): bool { return $this === self::Closed; }",
        "}",
        "const DEFAULT_STATE = State::Open;",
        "$normalize = static fn (string $value): string => trim($value);",
        "$factory = function (Store $store) use ($normalize): callable {",
        "  return fn (object $value) => $store->save($value);",
        "};",
        "/** Builds a store. */",
        "function buildStore(): Store {",
        "  return new class implements Store {",
        "    public function save(object $value): void {}",
        "  };",
        "}",
      ].join("\n"),
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Store", kind: "class" }),
        expect.objectContaining({ name: "save", kind: "method" }),
        expect.objectContaining({ name: "Audits", kind: "class" }),
        expect.objectContaining({ name: "audit", kind: "method" }),
        expect.objectContaining({ name: "State.Open", kind: "constant" }),
        expect.objectContaining({ name: "State.Closed", kind: "constant" }),
        expect.objectContaining({ name: "terminal", kind: "method" }),
        expect.objectContaining({ name: "DEFAULT_STATE", kind: "constant" }),
        expect.objectContaining({ name: "normalize", kind: "function" }),
        expect.objectContaining({ name: "factory", kind: "function" }),
        expect.objectContaining({
          name: "buildStore",
          kind: "function",
          source: expect.stringContaining("Builds a store"),
        }),
      ]),
    );
    expect(units.filter(({ name }) => name === "save")).toHaveLength(1);
  });

  it("splits PHPUnit tests, hooks, and data providers under their suite", () => {
    const units = analyze(
      [
        "<?php",
        "namespace Tests\\Feature;",
        "use PHPUnit\\Framework\\Attributes\\DataProvider;",
        "use PHPUnit\\Framework\\Attributes\\Test;",
        "use PHPUnit\\Framework\\TestCase;",
        "",
        "final class InvoiceTest extends TestCase",
        "{",
        "  protected function setUp(): void { parent::setUp(); }",
        "  protected function tearDown(): void {}",
        "",
        "  #[DataProvider('invalidInvoices')]",
        "  #[Test]",
        "  public function rejects_invalid_invoice(array $invoice): void {}",
        "",
        "  public function testSavesInvoice(): void {}",
        "",
        "  public static function invalidInvoices(): iterable { yield [[]]; }",
        "  public static function provideCurrencies(): iterable { yield ['DKK']; }",
        "}",
      ].join("\n"),
      "tests/Feature/InvoiceTest.php",
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "InvoiceTest", kind: "test_suite" }),
        expect.objectContaining({
          name: "InvoiceTest › setUp",
          kind: "test_hook",
        }),
        expect.objectContaining({
          name: "InvoiceTest › tearDown",
          kind: "test_hook",
        }),
        expect.objectContaining({
          name: "InvoiceTest › rejects_invalid_invoice",
          kind: "test",
        }),
        expect.objectContaining({
          name: "InvoiceTest › testSavesInvoice",
          kind: "test",
        }),
        expect.objectContaining({
          name: "InvoiceTest › invalidInvoices",
          kind: "test_hook",
        }),
        expect.objectContaining({
          name: "InvoiceTest › provideCurrencies",
          kind: "test_hook",
        }),
      ]),
    );
    const rejects = units.find(
      ({ name }) => name === "InvoiceTest › rejects_invalid_invoice",
    );
    const provider = units.find(
      ({ name }) => name === "InvoiceTest › invalidInvoices",
    );
    expect(rejects?.dependencies).toContain(provider?.stableKey);
  });

  it("extracts nested Pest suites, tests, hooks, datasets, and chained configuration", () => {
    const units = analyze(
      [
        "<?php",
        "use function Pest\\Laravel\\get;",
        "",
        "describe('invoices', function () {",
        "  beforeEach(function () { $this->seed(); });",
        "  dataset('currencies', [['DKK'], ['EUR']]);",
        "  it('lists invoices', function () { get('/invoices')->assertOk(); })->group('http');",
        "  test('rejects bad input', fn () => expect(true)->toBeTrue());",
        "});",
      ].join("\n"),
      "tests/Feature/invoices.php",
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "invoices", kind: "test_suite" }),
        expect.objectContaining({
          name: "invoices › beforeeach",
          kind: "test_hook",
        }),
        expect.objectContaining({
          name: "invoices › currencies",
          kind: "test_hook",
        }),
        expect.objectContaining({
          name: "invoices › lists invoices",
          kind: "test",
          source: expect.stringContaining("->group('http')"),
        }),
        expect.objectContaining({
          name: "invoices › rejects bad input",
          kind: "test",
        }),
      ]),
    );
    const suite = units.find(({ name }) => name === "invoices");
    const test = units.find(({ name }) => name === "invoices › lists invoices");
    expect(suite?.source).not.toContain("lists invoices");
    expect(suite?.dependencies).toContain(test?.stableKey);
  });

  it("keeps declarations, namespaces, imports, and included files as context", () => {
    const source = [
      "<?php",
      "declare(strict_types=1);",
      "namespace Acme {",
      "  use Acme\\Contracts\\Store;",
      "  use function Acme\\Support\\normalize;",
      "  require_once __DIR__ . '/bootstrap.php';",
      "}",
    ].join("\n");
    expect(phpAdapter.isContextOnly?.(source)).toBe(true);
    expect(analyze(source)).toEqual([]);
  });

  it("keeps meaningful namespace bootstrapping while ignoring imports", () => {
    const units = analyze(
      [
        "<?php",
        "namespace Acme;",
        "use Acme\\Container;",
        "require __DIR__ . '/vendor/autoload.php';",
        "$container = Container::boot();",
      ].join("\n"),
    );
    expect(units).toEqual([
      expect.objectContaining({
        name: "Acme namespace setup",
        kind: "module",
        source: "$container = Container::boot();",
      }),
    ]);
    expect(phpAdapter.isContextOnly?.("<?php echo 'ready';")).toBe(false);
  });

  it("does not split syntax hidden in comments, strings, heredocs, or anonymous constructs", () => {
    const units = analyze(
      [
        "<?php",
        "// class Fake { public function nope() {} }",
        "/** A real function. */",
        "function render(): string {",
        "  $quoted = 'function fake() { class Noise {} }';",
        "  $template = <<<HTML",
        "class AlsoNoise { public function no(): void {} }",
        "HTML;",
        "  $callback = new class { public function hidden(): void {} };",
        "  return $quoted . $template;",
        "}",
      ].join("\n"),
    );
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ name: "render", kind: "function" });
  });

  it("handles alternative control syntax as setup instead of false declarations", () => {
    const units = analyze(
      [
        "<?php",
        "if ($enabled):",
        "  foreach ($items as $item):",
        "    echo $item;",
        "  endforeach;",
        "endif;",
        "function ready(): bool { return true; }",
      ].join("\n"),
    );
    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Module setup",
          kind: "module",
          source: expect.stringContaining("endif;"),
        }),
        expect.objectContaining({ name: "ready", kind: "function" }),
      ]),
    );
    expect(units.filter(({ name }) => name === "Module setup")).toHaveLength(1);
    expect(units.filter(({ name }) => name === "ready")).toHaveLength(1);
  });
});
