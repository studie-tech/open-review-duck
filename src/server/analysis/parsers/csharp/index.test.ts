import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { csharpAdapter } from ".";

/** Runs the adapter directly so extraction can be verified independently. */
function analyze(path: string, content: string) {
  return csharpAdapter.analyze({ path, content } satisfies SourceFile);
}

describe("C# review parser", () => {
  it("extracts documented class members and links a shell to direct children", () => {
    const units = analyze(
      "src/Orders/OrderService.cs",
      [
        "using System.Text;",
        "using Domain.Models;",
        "",
        "namespace Acme.Orders;",
        "",
        "/// <summary>Coordinates orders.</summary>",
        "[Service(typeof(Order))]",
        "public sealed class OrderService<T> : IService<T>",
        "{",
        "    /// <summary>Maximum attempts.</summary>",
        "    public const int MaxAttempts = 3;",
        "    private readonly IRepository repository;",
        "",
        '    public string Name { get; init; } = "orders";',
        "    public event EventHandler? Saved;",
        "",
        "    public OrderService(IRepository repository)",
        "    {",
        "        this.repository = repository;",
        "    }",
        "",
        "    static OrderService() => Register();",
        "",
        "    /// <summary>Persists one order.</summary>",
        "    [Trace]",
        "    public async Task<Order> SaveAsync(Order order)",
        "    {",
        '        var raw = $$"""{ not a body } {{order.Id}}""";',
        "        return await repository.SaveAsync(order);",
        "    }",
        "",
        "    public static implicit operator string(OrderService<T> value) => value.Name;",
        "",
        "    public record Result(int Count);",
        "}",
      ].join("\n"),
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "OrderService", kind: "class" }),
        expect.objectContaining({
          name: "OrderService.MaxAttempts",
          kind: "constant",
        }),
        expect.objectContaining({
          name: "OrderService.repository",
          kind: "variable",
        }),
        expect.objectContaining({
          name: "OrderService.Name",
          kind: "variable",
        }),
        expect.objectContaining({
          name: "OrderService.Saved",
          kind: "variable",
        }),
        expect.objectContaining({ name: "OrderService", kind: "method" }),
        expect.objectContaining({ name: "SaveAsync", kind: "method" }),
        expect.objectContaining({
          name: "implicit operator string",
          kind: "method",
        }),
        expect.objectContaining({ name: "Result", kind: "class" }),
      ]),
    );
    const service = units.find(
      ({ name, kind }) => name === "OrderService" && kind === "class",
    );
    const save = units.find(({ name }) => name === "SaveAsync");
    const repository = units.find(
      ({ name }) => name === "OrderService.repository",
    );
    const result = units.find(
      ({ name, kind }) => name === "Result" && kind === "class",
    );

    expect(service?.source).toContain("<summary>Coordinates orders.</summary>");
    expect(service?.source).toContain("[Service(typeof(Order))]");
    expect(service?.source).not.toContain("SaveAsync");
    expect(save?.source).toContain("<summary>Persists one order.</summary>");
    expect(save?.source).toContain('$$"""{ not a body } {{order.Id}}"""');
    expect(save?.dependencies).toContain(repository?.stableKey);
    expect(service?.dependencies).toEqual(
      expect.arrayContaining([
        save?.stableKey,
        repository?.stableKey,
        result?.stableKey,
      ]),
    );
    expect(units.some(({ source }) => /^\s*using\b/m.test(source))).toBe(false);
  });

  it("supports block namespaces, interfaces, structs, enums, delegates, and nested types", () => {
    const units = analyze(
      "src/Protocol.cs",
      [
        "namespace Acme.Protocol {",
        "    public interface IHandler<T>",
        "    {",
        "        ValueTask<T> HandleAsync(T value);",
        "    }",
        "",
        "    public readonly struct Identifier",
        "    {",
        "        public required string Value { get; init; }",
        "    }",
        "",
        "    public enum Status",
        "    {",
        "        Unknown = 0,",
        "        Ready = 1,",
        "    }",
        "",
        "    public delegate Task CompletedHandler(object sender, EventArgs args);",
        "}",
      ].join("\n"),
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "IHandler", kind: "class" }),
        expect.objectContaining({ name: "HandleAsync", kind: "method" }),
        expect.objectContaining({ name: "Identifier", kind: "class" }),
        expect.objectContaining({ name: "Identifier.Value", kind: "variable" }),
        expect.objectContaining({ name: "Status.Unknown", kind: "constant" }),
        expect.objectContaining({ name: "Status.Ready", kind: "constant" }),
        expect.objectContaining({ name: "CompletedHandler", kind: "class" }),
      ]),
    );
    expect(units.some(({ name }) => name.startsWith("Namespace "))).toBe(false);
  });

  it("recognizes xUnit, NUnit, and MSTest tests and lifecycle hooks", () => {
    const units = analyze(
      "tests/CheckoutTests.cs",
      [
        "using Xunit;",
        "using NUnit.Framework;",
        "using Microsoft.VisualStudio.TestTools.UnitTesting;",
        "",
        "[TestFixture]",
        "public sealed class CheckoutTests : IDisposable",
        "{",
        "    public CheckoutTests() { ResetDatabase(); }",
        "",
        '    [Fact(DisplayName = "charges a valid card")]',
        "    public void ChargesCard() { Assert.True(Charge()); }",
        "",
        "    [Theory]",
        "    [InlineData(1)]",
        "    public void RejectsInvalid(int value) { Assert.False(Validate(value)); }",
        "",
        "    [SetUp]",
        "    public void BeforeEach() { ResetDatabase(); }",
        "",
        '    [TestCase(2, TestName = "NUnit case")]',
        "    public void NUnitCase(int value) { Assert.That(value, Is.EqualTo(2)); }",
        "",
        "    [TestMethod]",
        "    public void MsTestCase() { MicrosoftAssert.IsTrue(true); }",
        "",
        "    public void Dispose() { Cleanup(); }",
        "}",
      ].join("\n"),
    );

    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "CheckoutTests", kind: "test_suite" }),
        expect.objectContaining({ name: "CheckoutTests", kind: "test_hook" }),
        expect.objectContaining({
          name: "CheckoutTests › charges a valid card",
          kind: "test",
        }),
        expect.objectContaining({
          name: "CheckoutTests › RejectsInvalid",
          kind: "test",
        }),
        expect.objectContaining({ name: "BeforeEach", kind: "test_hook" }),
        expect.objectContaining({
          name: "CheckoutTests › NUnit case",
          kind: "test",
        }),
        expect.objectContaining({
          name: "CheckoutTests › MsTestCase",
          kind: "test",
        }),
        expect.objectContaining({ name: "Dispose", kind: "test_hook" }),
      ]),
    );
    expect(units.filter(({ kind }) => kind === "test")).toHaveLength(4);
  });

  it("keeps imports as context and retains executable top-level statements", () => {
    const importOnly = analyze(
      "src/GlobalUsings.cs",
      [
        "global using System;",
        "global using Task = System.Threading.Tasks.Task;",
      ].join("\n"),
    );
    expect(importOnly).toEqual([]);
    expect(
      csharpAdapter.isContextOnly?.(
        "using System;\nnamespace Acme.Tools {\n}\n",
      ),
    ).toBe(true);

    const statements = analyze(
      "src/Program.cs",
      [
        "using Microsoft.AspNetCore.Builder;",
        "",
        "var builder = WebApplication.CreateBuilder(args);",
        "builder.Services.AddControllers();",
        "var app = builder.Build();",
        "app.Run();",
      ].join("\n"),
    );
    expect(statements).toEqual([
      expect.objectContaining({
        name: "Top-level statements",
        kind: "module",
        source: expect.stringContaining("CreateBuilder"),
      }),
    ]);
    expect(statements[0]?.source).not.toContain("using Microsoft");
  });

  it("does not confuse comments, verbatim strings, or interpolated raw strings with declarations", () => {
    const units = analyze(
      "src/Tricky.cs",
      [
        "public class Tricky",
        "{",
        "    // public void Phantom() { }",
        '    private const string Template = @"class Fake { \\"nope\\" }";',
        '    private const string Raw = $"""method {{GetValue()}} }}}""";',
        "",
        "    public string GetValue() => Template + Raw;",
        "}",
      ].join("\n"),
    );

    expect(units.some(({ name }) => name === "Phantom")).toBe(false);
    expect(units.filter(({ name }) => name === "GetValue")).toHaveLength(1);
    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Tricky.Template", kind: "constant" }),
        expect.objectContaining({ name: "Tricky.Raw", kind: "constant" }),
      ]),
    );
  });
});
