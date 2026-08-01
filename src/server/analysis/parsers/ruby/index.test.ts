import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { isContextOnly, rubyAdapter, rubyExtensions, rubyFileNames } from ".";

/** Analyzes an in-memory Ruby fixture. */
function analyze(content: string, path = "lib/review_duck/service.rb") {
  return rubyAdapter.analyze({
    path,
    content,
    changeType: "added",
  } satisfies SourceFile);
}

/** Returns a fixture unit by name with a useful assertion failure. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected ${name}; received ${units.map((candidate) => `${candidate.kind}:${candidate.name}`).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing Ruby unit ${name}`);
  return unit;
}

describe("Ruby review parser", () => {
  it("extracts documented namespace shells, state, methods, singleton methods, and dependencies", () => {
    const units = analyze(`# frozen_string_literal: true

require "json"

module ReviewDuck
  # Coordinates review persistence.
  class Service < BaseService
    # Maximum number of attempts.
    DEFAULT_RETRIES = 3
    @registry = {}
    @@instances = 0

    attr_reader :repository, :logger

    # Persists one review and returns its identifier.
    def save(review)
      logger.info(review)
      repository.save(normalize(review), DEFAULT_RETRIES)
    end

    # Normalizes a review.
    def normalize(review) = review.to_h

    class << self
      # Builds a default service.
      def build
        new(default_repository)
      end
    end

    # Nested data owned by the service.
    class Result
      attr_reader :id
    end
  end
end
`);

    const service = named(units, "Service");
    expect(service.kind).toBe("class");
    expect(service.source).toContain("Coordinates review persistence");
    expect(service.source).not.toContain("DEFAULT_RETRIES");
    expect(service.dependencies).toEqual(
      expect.arrayContaining([
        named(units, "ReviewDuck::Service::DEFAULT_RETRIES").stableKey,
      ]),
    );

    expect(named(units, "ReviewDuck::Service::DEFAULT_RETRIES")).toMatchObject({
      kind: "constant",
      source: expect.stringContaining("Maximum number of attempts"),
    });
    expect(named(units, "ReviewDuck::Service::@registry").kind).toBe(
      "variable",
    );
    expect(named(units, "ReviewDuck::Service::@@instances").kind).toBe(
      "variable",
    );
    expect(
      named(units, "ReviewDuck::Service#attributes repository, logger").kind,
    ).toBe("method");

    const save = named(units, "ReviewDuck::Service#save");
    expect(save.source).toContain("Persists one review");
    expect(save.dependencies).toEqual(
      expect.arrayContaining([
        named(units, "ReviewDuck::Service#normalize").stableKey,
        named(units, "ReviewDuck::Service::DEFAULT_RETRIES").stableKey,
      ]),
    );
    expect(named(units, "ReviewDuck::Service.build").kind).toBe("method");
    expect(named(units, "Result").source).toContain("Nested data owned");
  });

  it("handles operator and endless methods plus safe named metaprogramming", () => {
    const units = analyze(`class Collection
  def [](index) = values[index]
  def []=(index, value)
    values[index] = value
  end
  def <=>(other) = size <=> other.size

  define_method(:active?) do
    state == :active
  end
  define_singleton_method("empty") { new([]) }
  alias present? active?
  alias_method :length, :size
  delegate :name, :email, to: :owner
  def_delegators :adapter, :read, :write
end
`);

    expect(named(units, "Collection#[]").source).toContain("values[index]");
    expect(named(units, "Collection#[]=").source).toContain(
      "values[index] = value",
    );
    expect(named(units, "Collection#<=>").kind).toBe("method");
    expect(named(units, "Collection#active?").kind).toBe("method");
    expect(named(units, "Collection#empty").kind).toBe("method");
    expect(named(units, "Collection#alias present?").kind).toBe("method");
    expect(named(units, "Collection#alias length").kind).toBe("method");
    expect(named(units, "Collection#delegates name, email").kind).toBe(
      "method",
    );
    expect(named(units, "Collection#delegates read, write").kind).toBe(
      "method",
    );
  });

  it("keeps constant blocks intact and groups top-level executable setup", () => {
    const units = analyze(
      `require_relative "support"

# Handles queued work.
HANDLER = lambda do |job|
  job.call
end

# Configure the application
ReviewDuck.configure do |config|
  config.handler = HANDLER
end

# Start workers
Workers.boot!
`,
      "config/boot.rb",
    );

    const handler = named(units, "HANDLER");
    expect(handler.kind).toBe("constant");
    expect(handler.source).toContain("job.call");
    const configure = named(units, "Configure the application");
    expect(configure.kind).toBe("module");
    expect(configure.source).toContain("ReviewDuck.configure");
    expect(configure.dependencies).toContain(handler.stableKey);
    expect(named(units, "Start workers").source).toContain("Workers.boot!");
  });

  it("keeps framework DSL and executable class-body setup reviewable", () => {
    const units = analyze(`class Account < ApplicationRecord
  include Auditable

  # Persistence rules
  belongs_to :organization
  validates :email, presence: true
  before_save do
    self.email = email.downcase
  end

  private

  def normalize
    email.strip
  end
end
`);

    const persistence = named(units, "Persistence rules");
    expect(persistence.kind).toBe("module");
    expect(persistence.source).toContain("belongs_to");
    expect(persistence.source).toContain("before_save");
    expect(named(units, "Account class setup").source).toContain(
      "include Auditable",
    );
    expect(units.some(({ source }) => source.trim() === "private")).toBe(true);
    expect(named(units, "Account").dependencies).toContain(
      persistence.stableKey,
    );
  });

  it("models nested RSpec suites, shared examples, hooks, and examples", () => {
    const units = analyze(
      `require "spec_helper"

RSpec.describe ReviewDuck::Service do
  subject(:service) { described_class.new(repository) }

  before(:each) do
    repository.clear
  end

  shared_examples "a persistent service" do
    it "returns an identifier" do
      expect(service.save(review)).to eq(42)
    end
  end

  context "when storage fails" do
    it "raises a useful error" do
      expect { service.save(review) }.to raise_error(StorageError)
    end
  end
end
`,
      "spec/review_duck/service_spec.rb",
    );

    const suite = named(units, "ReviewDuck::Service");
    expect(suite.kind).toBe("test_suite");
    expect(suite.source).not.toContain("returns an identifier");
    expect(named(units, "ReviewDuck::Service › subject").kind).toBe(
      "test_hook",
    );
    expect(named(units, "ReviewDuck::Service › before").kind).toBe("test_hook");
    expect(
      named(units, "ReviewDuck::Service › a persistent service").kind,
    ).toBe("test_suite");
    expect(
      named(
        units,
        "ReviewDuck::Service › a persistent service › returns an identifier",
      ).kind,
    ).toBe("test");
    expect(named(units, "ReviewDuck::Service › when storage fails").kind).toBe(
      "test_suite",
    );
    expect(
      named(
        units,
        "ReviewDuck::Service › when storage fails › raises a useful error",
      ).kind,
    ).toBe("test");
    expect(suite.dependencies.length).toBeGreaterThan(0);
  });

  it("recognizes Minitest and Test::Unit without misclassifying production setup", () => {
    const units = analyze(
      `class ServiceTest < Minitest::Test
  def setup
    @service = Service.new
  end

  def test_saves_records
    assert @service.save(record)
  end

  test "rejects invalid records" do
    assert_raises(ValidationError) { @service.save(nil) }
  end
end
`,
      "test/service_test.rb",
    );
    expect(named(units, "ServiceTest").kind).toBe("test_suite");
    expect(named(units, "ServiceTest › setup").kind).toBe("test_hook");
    expect(named(units, "ServiceTest › test_saves_records").kind).toBe("test");
    expect(named(units, "ServiceTest › rejects invalid records").kind).toBe(
      "test",
    );

    const production = analyze(
      `class Server
  def setup
    connect
  end
end
`,
      "lib/server.rb",
    );
    expect(named(production, "Server#setup").kind).toBe("method");
  });

  it("handles refinements and keeps their methods separate", () => {
    const units = analyze(`module Formatting
  refine String do
    # Adds terminal emphasis.
    def emphasize
      "**#{self}**"
    end
  end
end

using Formatting
`);
    const refinement = named(units, "Refinement(String)");
    expect(refinement.kind).toBe("class");
    expect(refinement.source).not.toContain("def emphasize");
    expect(
      named(units, "Formatting::Refinement(String)#emphasize"),
    ).toBeDefined();
    expect(named(units, "Ruby setup").source).toContain("using Formatting");
  });

  it("ignores declaration-shaped text in strings, regexes, percent literals, heredocs, and comments", () => {
    const source = `class Real
  TEMPLATE = <<~RUBY
    class Fake
      def nope
      end
    end
  RUBY

  TEXT = %q{def fake; end}
  PATTERN = /class Fake; def nope; end/
  INTERPOLATED = "#{'def also_fake; end'}"
  # class Commented; def hidden; end

  def actual
    12 / 3
  end
end
`;
    const units = analyze(source);
    expect(units.some(({ name }) => /Fake|fake|nope|hidden/.test(name))).toBe(
      false,
    );
    expect(named(units, "Real#actual").source).toContain("12 / 3");
  });

  it("treats frozen-string, comments, and load-only preambles as context", () => {
    const context = `#!/usr/bin/env ruby
# frozen_string_literal: true
# encoding: UTF-8
require "bundler/setup"
require_relative("support")
load File.expand_path("environment.rb", __dir__)
autoload :Service, "review_duck/service"
`;
    expect(isContextOnly(context)).toBe(true);
    expect(analyze(context, "Gemfile")).toEqual([]);
    expect(isContextOnly(`${context}\nBundler.require(*Rails.groups)\n`)).toBe(
      false,
    );
    expect(rubyAdapter.extensions).toBe(rubyExtensions);
    expect(rubyAdapter.fileNames).toBe(rubyFileNames);
    expect(rubyFileNames).toEqual(
      expect.arrayContaining(["rakefile", "gemfile"]),
    );
  });
});
