import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { isContextOnly, luaAdapter } from ".";

/** Analyzes an in-memory Lua fixture with a representative source path. */
function analyze(content: string, path = "src/service.lua") {
  return luaAdapter.analyze({ path, content, changeType: "added" });
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

describe("Lua review analysis", () => {
  it("extracts documented functions, closures, configuration, and returned modules", () => {
    const units = analyze(`local json = require("cjson.safe")
local clock = require "clock"

local M = {}

--- Maximum number of delivery attempts.
---@type integer
local MAX_ATTEMPTS = 4

local defaults = {
  timeout = 30,
  retries = MAX_ATTEMPTS,
}

--- Formats a message for transport.
---@param value table
---@return string
local function encode(value)
  return json.encode(value)
end

--- Produces the current delivery envelope.
M.envelope = function(value)
  return {
    sent_at = clock.now(),
    body = encode(value),
  }
end

function M.publish(value)
  return M.envelope(value)
end

return M
`);

    expect(luaAdapter.extensions).toContain(".lua");
    const maximum = named(units, "MAX_ATTEMPTS");
    expect(maximum.kind).toBe("constant");
    expect(maximum.source).toContain("---@type integer");
    expect(named(units, "defaults").kind).toBe("constant");

    const encode = named(units, "encode");
    expect(encode.kind).toBe("function");
    expect(encode.source).toContain("Formats a message");
    expect(encode.dependencies).toContain("lua-require:cjson.safe");
    const envelope = named(units, "M.envelope");
    expect(envelope.dependencies).toEqual(
      expect.arrayContaining([encode.stableKey, "lua-require:clock"]),
    );
    expect(named(units, "M.publish").dependencies).toContain(
      envelope.stableKey,
    );

    const module = named(units, "Module M");
    expect(module.kind).toBe("module");
    expect(module.source).not.toContain("function M.publish");
    expect(module.dependencies).toEqual(
      expect.arrayContaining([
        envelope.stableKey,
        named(units, "M.publish").stableKey,
      ]),
    );
  });

  it("recognizes metatable class concepts and orders their methods beneath the shell", () => {
    const units = analyze(`--- A queue with bounded capacity.
---@class Queue
local Queue = {}
Queue.__index = Queue

function Queue.new(capacity)
  return setmetatable({ capacity = capacity, values = {} }, Queue)
end

function Queue:push(value)
  if #self.values >= self.capacity then
    return false
  end
  table.insert(self.values, value)
  return true
end

function Queue:size()
  return #self.values
end
`);

    const queue = named(units, "Class Queue");
    expect(queue.kind).toBe("class");
    expect(queue.source).toContain("---@class Queue");
    expect(queue.source).not.toContain("function Queue.new");
    const createQueue = named(units, "Queue.new");
    const push = named(units, "Queue:push");
    const size = named(units, "Queue:size");
    expect(createQueue.kind).toBe("method");
    expect(push.kind).toBe("method");
    expect(queue.dependencies).toEqual(
      expect.arrayContaining([
        createQueue.stableKey,
        push.stableKey,
        size.stableKey,
      ]),
    );
    expect(push.complexity).toBeGreaterThan(1);
  });

  it("splits nested Busted tests and hooks with suite-qualified names", () => {
    const units = analyze(
      `local service = require("service")

describe("delivery service", function()
  before_each(function()
    service.reset()
  end)

  context("when online", function()
    it("publishes the message", function()
      assert.is_true(service.publish("hello"))
    end)

    test("records metrics", function()
      service.publish("hello")
      assert.equals(1, service.metric_count())
    end)
  end)

  after_each(function()
    service.close()
  end)
end)
`,
      "spec/service_spec.lua",
    );

    const setup = named(units, "delivery service › before each");
    expect(setup.kind).toBe("test_hook");
    expect(setup.dependencies).toContain("lua-require:service");
    const publishes = named(
      units,
      "delivery service › when online › publishes the message",
    );
    expect(publishes.kind).toBe("test");
    expect(publishes.source).not.toContain("records metrics");
    expect(
      named(units, "delivery service › when online › records metrics").kind,
    ).toBe("test");
    expect(named(units, "delivery service › after each").kind).toBe(
      "test_hook",
    );
  });

  it("classifies luaunit methods without mistaking production methods for tests", () => {
    const testUnits = analyze(
      `TestAccount = {}

function TestAccount:setUp()
  self.account = { balance = 0 }
end

function TestAccount:test_deposit()
  self.account.balance = self.account.balance + 5
  luaunit.assertEquals(self.account.balance, 5)
end

function TestAccount:tearDown()
  self.account = nil
end
`,
      "test/test_account.lua",
    );
    expect(named(testUnits, "TestAccount › setUp").kind).toBe("test_hook");
    expect(named(testUnits, "TestAccount › test_deposit").kind).toBe("test");
    expect(named(testUnits, "TestAccount › tearDown").kind).toBe("test_hook");

    const production = analyze(`local Worker = {}
function Worker:test_connection()
  return socket.ping()
end
`);
    expect(named(production, "Worker:test_connection").kind).toBe("method");
  });

  it("handles arbitrary long brackets and misleading syntax in comments and strings", () => {
    const content = `--[==[
function fake()
  return "end"
end
]==]

local TEMPLATE = [=[
function also_fake()
  if true then end
end
]=]

local quoted = "function nope() return 'end' end"

local function real(value)
  local nested = [==[ repeat until false function hidden() end ]==]
  repeat
    value = value - 1
  until value <= 0
  return nested
end
`;
    const units = analyze(content);
    expect(units.some(({ name }) => name.includes("fake"))).toBe(false);
    expect(units.some(({ name }) => name.includes("nope"))).toBe(false);
    expect(named(units, "TEMPLATE").kind).toBe("constant");
    expect(named(units, "quoted").kind).toBe("variable");
    expect(named(units, "real").source).toContain("until value <= 0");
  });

  it("keeps require-only preambles as context while reviewing executable setup", () => {
    const context = `--- Optional JSON implementation.
local json = require "cjson"
local clock = require("clock")
require "compat"
`;
    expect(isContextOnly(context)).toBe(true);
    expect(
      luaAdapter.analyze({
        path: "src/imports.lua",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(isContextOnly("local ready = initialize()\n")).toBe(false);
    expect(named(analyze("initialize()\n"), "Lua module statements").kind).toBe(
      "module",
    );
  });

  it("reviews the same module identically however many times a process parses it", () => {
    // The Lua grammar owns mutable scanner state across parses. A server
    // analyses many Lua files, and `analyze` itself parses more than once, so
    // a reviewer must see the same cards for the tenth file as for the first.
    const content = `local M = {}

function M.configure(options)
  M.options = options
end

function M.reset()
  M.options = nil
end

return M
`;
    /** Summarises the review cards a reviewer would see for one analysis. */
    const cards = () =>
      analyze(content, "src/settings.lua").map(
        ({ kind, name, startLine, endLine }) => ({
          kind,
          name,
          startLine,
          endLine,
        }),
      );

    const first = cards();
    expect(cards()).toEqual(first);
    expect(cards()).toEqual(first);
    // Both functions must stay separately reviewable rather than collapsing
    // into one oversized card or vanishing into anonymous module statements.
    expect(first).toEqual(
      expect.arrayContaining([
        { kind: "method", name: "M.configure", startLine: 3, endLine: 5 },
        { kind: "method", name: "M.reset", startLine: 7, endLine: 9 },
        { kind: "module", name: "Module M", startLine: 11, endLine: 11 },
      ]),
    );
  });

  it("keeps an unterminated long string from bleeding into the next file", () => {
    // Truncated diffs and generated fixtures do reach the parser; a file that
    // ends inside `[[` must not turn the next module's plain code into string
    // soup, which would erase every card in that file.
    analyze("local fragment = [[ unterminated\n", "src/fragment.lua");
    const units = analyze(`local Cache = {}

function Cache.put(key, value)
  Cache[key] = value
end

return Cache
`);
    expect(named(units, "Cache.put").kind).toBe("method");
    expect(named(units, "Cache.put").source).toContain("Cache[key] = value");
    expect(named(units, "Module Cache").kind).toBe("module");
  });

  it("does not leak nested named functions into duplicate review units", () => {
    const units = analyze(`local function outer(value)
  local function normalize(item)
    return tostring(item)
  end
  return normalize(value)
end
`);
    expect(named(units, "outer").source).toContain("local function normalize");
    expect(units.some(({ name }) => name === "normalize")).toBe(false);
  });
});
