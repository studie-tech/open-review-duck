import { describe, expect, it } from "vitest";
import { analyzeFiles } from "../engine";
import type { AnalyzedUnit } from "../types";

/** Reviews one file and drops the whole-file unit every analysis emits. */
function analyze(path: string, content: string) {
  return analyzeFiles([{ path, content }]).units.filter(
    ({ kind }) => kind !== "file",
  );
}

/** Renders units as `kind name` in source order, the order a reviewer sees. */
function shape(units: AnalyzedUnit[]) {
  return [...units]
    .sort((left, right) => left.startLine - right.startLine)
    .map(({ kind, name }) => `${kind} ${name}`);
}

/** Renders units as `start-end kind name`, the placement a reviewer navigates. */
function placedShape(units: AnalyzedUnit[]) {
  return [...units]
    .sort((left, right) => left.startLine - right.startLine)
    .map(
      ({ startLine, endLine, kind, name }) =>
        `${startLine}-${endLine} ${kind} ${name}`,
    );
}

/** Returns one named unit while reporting the real cards on a miss. */
function named(units: AnalyzedUnit[], name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected a card named ${name}; received ${units.map((c) => c.name).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing unit ${name}`);
  return unit;
}

/** Returns the leftover ranges swept up because no declaration claimed them. */
function anonymousUnits(units: AnalyzedUnit[]) {
  return units.filter(({ name }) => name === "Module statements");
}

describe("declaration naming", () => {
  it("titles protobuf declarations with their identifiers, not their keywords", () => {
    // Three messages titled "message" are three indistinguishable cards, and a
    // field inherits its owner's title, so the keyword spreads to every child.
    const units = analyze(
      "api/review.proto",
      `syntax = "proto3";

message Review {
  string id = 1;
}

message Comment {
  string body = 1;
}

enum Status {
  STATUS_OPEN = 0;
}

service ReviewService {
  rpc GetReview(GetReviewRequest) returns (Review);
  rpc ListReviews(ListReviewsRequest) returns (ListReviewsResponse);
}
`,
    );

    expect(shape(units)).toEqual(
      expect.arrayContaining([
        "class Review",
        "variable Review.id",
        "class Comment",
        "variable Comment.body",
        "class Status",
        "constant Status.STATUS_OPEN",
        "class ReviewService",
        "method GetReview",
        "method ListReviews",
      ]),
    );
  });

  it("titles Dockerfile stages with their aliases and instructions with their arguments", () => {
    // A multi-stage build is reviewed stage by stage, so the alias a later
    // stage copies from has to be on the card. The four COPY instructions do
    // unrelated things and must not collapse into four cards named "COPY".
    const units = analyze(
      "Dockerfile",
      `FROM node:20-alpine AS deps
COPY package.json ./
RUN npm ci

FROM node:20-alpine AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
`,
    );

    expect(shape(units)).toEqual([
      "module deps",
      "module COPY package.json ./",
      "module RUN npm ci",
      "module runner",
      "variable NODE_ENV",
      "module COPY --from=deps /app/node_modules ./node_modules",
      `module CMD ["node", "dist/index.js"]`,
    ]);
  });

  it("titles Julia declarations past their leading keywords", () => {
    // `mutable struct` puts two keywords ahead of the identifier, so a rule
    // that reads the first word of the declaration never reaches the name.
    const units = analyze(
      "src/Reviews.jl",
      `abstract type AbstractReview end

struct Review <: AbstractReview
    id::String
end

mutable struct ReviewState
    open::Bool
end

function summarize(review::Review)
    return review.id
end

macro trace(expr)
    return expr
end
`,
    );

    expect(shape(units)).toEqual([
      "class AbstractReview",
      "class Review",
      "variable Review.id",
      "class ReviewState",
      "variable ReviewState.open",
      "function summarize",
      "class trace",
    ]);
  });

  it("titles OCaml and F# bindings with the bound name", () => {
    // Every OCaml value definition opens with `let`, so keyword titles make an
    // entire module read as a stack of cards called "let".
    expect(
      shape(
        analyze(
          "lib/review.ml",
          `type review = { id : string }

let make id = { id }

let id_of review = review.id

module Store = struct
  let empty = []
end
`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "class review",
        "function make",
        "function id_of",
        "class Store",
        "method empty",
      ]),
    );

    // An F# member is written `member this.Add`; the instance qualifier is not
    // the member's name, and `abstract member` adds a second leading keyword.
    expect(
      shape(
        analyze(
          "src/Review.fs",
          `type Store() =
    member this.Add(review) = review
    abstract member Count : int
`,
        ),
      ),
    ).toEqual(["class Store", "method Add", "method Count"]);
  });

  it("keeps Zig container literals from becoming keyword-titled duplicate cards", () => {
    // `const Status = enum {...}` is one declaration. The anonymous literal has
    // no name of its own, so it must not add a second card titled "enum"
    // covering the exact same lines as the constant that owns it.
    const units = analyze(
      "src/review.zig",
      `const Status = enum {
    open,
    closed,
};

const Review = struct {
    id: []const u8,
};

pub fn summarize(review: Review) []const u8 {
    return review.id;
}
`,
    );

    expect(shape(units)).toEqual([
      "constant Status",
      "constant Review",
      "function summarize",
    ]);
  });

  it("titles Perl packages and variables past their declaring keywords", () => {
    const units = analyze(
      "lib/Review/Store.pm",
      `package Review::Store;

our $VERSION = '1.0';

my $cache = {};

sub new {
    my ($class) = @_;
    return bless {}, $class;
}
`,
    );

    expect(shape(units)).toEqual(
      expect.arrayContaining([
        "class Review",
        "variable VERSION",
        "variable cache",
        "function new",
      ]),
    );
  });

  it("titles CSS rules with the selector that identifies them", () => {
    // A CSS rule has no identifier — its selector is its identity. Titling by
    // the first class name makes `.card` and `.card:hover` the same card, and
    // titling by the at-rule keyword makes every breakpoint read as "media".
    const units = analyze(
      "styles/review.css",
      `.card {
  padding: 12px;
}

.card:hover {
  padding: 16px;
}

@media (max-width: 600px) {
  .card {
    padding: 8px;
  }
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}
`,
    );

    expect(shape(units)).toEqual(
      expect.arrayContaining([
        "class .card",
        "class .card:hover",
        "class @media (max-width: 600px)",
        "class fade-in",
      ]),
    );
  });

  it("tells successive SQL migrations apart", () => {
    // A migration is a list of statements that all start with the same verb;
    // two cards titled "ALTER" give a reviewer nothing to sign off against.
    const units = analyze(
      "drizzle/0001_reviews.sql",
      `CREATE TABLE reviews (
  id uuid PRIMARY KEY
);

ALTER TABLE reviews ADD COLUMN status text NOT NULL DEFAULT 'open';

ALTER TABLE reviews ADD COLUMN author_id uuid;
`,
    );

    const titles = shape(units);
    expect(titles).toEqual(
      expect.arrayContaining(["class reviews", "variable status"]),
    );
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("titles Dart members with the declarator rather than the type", () => {
    // Dart writes the type first, so reading the first identifier yields
    // "String", "Widget" and "void" — the same handful of titles on every card.
    const units = analyze(
      "lib/review_card.dart",
      `class ReviewCard extends StatefulWidget {
  final String name;
  final int count;

  Widget build(BuildContext context) {
    return Container();
  }

  void dispose() {
    super.dispose();
  }
}
`,
    );

    expect(shape(units)).toEqual(
      expect.arrayContaining([
        "class ReviewCard",
        "variable ReviewCard.name",
        "variable ReviewCard.count",
        "method build",
        "method dispose",
      ]),
    );
  });

  it("titles Scala enum cases with the case they declare", () => {
    const units = analyze(
      "src/Status.scala",
      `enum Status:
  case Open
  case Closed
`,
    );

    expect(shape(units)).toEqual([
      "class Status",
      "variable Status.Open",
      "variable Status.Closed",
    ]);
  });

  it("keeps a keyword-titled card from replacing a Kotlin class name", () => {
    // Kotlin spells a class name with the same node a type annotation uses, so
    // a rule that skips type nodes must not fall through to the supertype.
    const units = analyze(
      "src/ReviewStore.kt",
      `typealias UserId = String

class ReviewStore : Store<Review>({
    val limit = 20
})
`,
    );

    expect(shape(units)).toEqual(
      expect.arrayContaining(["class UserId", "class ReviewStore"]),
    );
  });

  it("leaves no declaration body stranded when a declaration goes unnamed", () => {
    // Refusing to title a card with a keyword must not silently drop the
    // declaration: its lines still belong to a card the reviewer can sign off.
    const units = analyze(
      "src/review.zig",
      `const Status = enum {
    open,
};
`,
    );

    expect(anonymousUnits(units)).toEqual([]);
    expect(units).toEqual([
      expect.objectContaining({ name: "Status", startLine: 1, endLine: 3 }),
    ]);
  });
});

describe("declarations whose body no other unit reviews", () => {
  it("keeps a TypeScript interface, enum, and object type alias whole", () => {
    const units = analyze(
      "a/types.ts",
      `export interface ReviewConceptDefinition {
  stableKey: string;
  title: string;
}

export enum Status {
  Pending = "pending",
  Done = "done",
}

export type Config = {
  retries: number;
};
`,
    );
    // A data shape is one decision; its opening brace is not a review unit.
    expect(
      units.map(({ startLine, endLine }) => `${startLine}-${endLine}`),
    ).toEqual(["1-4", "6-9", "11-13"]);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("keeps a SQL table definition whole", () => {
    const units = analyze(
      "drizzle/0001_init.sql",
      `CREATE TABLE "concept" (
\t"id" uuid PRIMARY KEY NOT NULL,
\t"title" text NOT NULL
);
`,
    );
    const table = units.find(({ name }) => name.includes("concept"));
    // NOT NULL, DEFAULT and REFERENCES only mean anything together.
    expect(table?.startLine).toBe(1);
    expect(table?.endLine).toBeGreaterThanOrEqual(4);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("keeps a Swift protocol whole", () => {
    const units = analyze(
      "a/Service.swift",
      `protocol Greeter {
    var name: String { get }
    func greet() -> String
}
`,
    );
    // A protocol's requirement list is a single contract.
    expect(shape(units)).toEqual(["class Greeter"]);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("still splits a class whose members carry statement bodies", () => {
    const units = analyze(
      "a/service.ts",
      `export class ReviewService {
  private name = "";

  run(): string {
    return this.name;
  }

  rename(next: string): void {
    this.name = next;
  }
}
`,
    );
    // Implementations are where defects live, so each earns its own sign-off.
    expect(shape(units)).toEqual([
      "class ReviewService",
      "variable ReviewService.name",
      "method run",
      "method rename",
    ]);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("extracts JavaScript class fields rather than leaving them unreviewed", () => {
    const units = analyze(
      "a/store.js",
      `export class Store {
  static instances = 0;
  #items = [];

  add(item) {
    this.#items.push(item);
  }
}
`,
    );
    // Fields carry real content and must never be silently absorbed.
    expect(units.filter(({ kind }) => kind === "variable")).toHaveLength(2);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("keeps a real module-level statement visible", () => {
    const units = analyze(
      "a/mixed.ts",
      `const limit = 10;

console.log("booting", limit);

export function load(): number {
  return limit;
}
`,
    );
    // Suppression must never reach past delimiters into executable code.
    expect(anonymousUnits(units)).toHaveLength(1);
  });

  it("collects a Ruby singleton method and addresses it through the class", () => {
    const units = analyze(
      "a/account.rb",
      `class Account
  def self.open(owner)
    new(owner)
  end

  def deposit(amount)
    @balance += amount
  end
end
`,
    );
    const names = units.map(({ name }) => name);
    // A public constructor is the most review-worthy method in the file.
    expect(names).toContain("Account.open");
    expect(names).toContain("Account#deposit");
  });

  it("suppresses keyword block closers the way it suppresses braces", () => {
    const units = analyze(
      "a/user.rb",
      `class User
  def name
    @name
  end
end
`,
    );
    // `end` closes the class rather than stating anything of its own.
    expect(anonymousUnits(units)).toEqual([]);
  });
});
describe("Elixir review analysis", () => {
  it("splits a module into per-definition cards instead of one module card", () => {
    const units = analyze(
      "lib/my_app/accounts.ex",
      `defmodule MyApp.Accounts do
  @moduledoc """
  Account management.
  """
  alias MyApp.Repo

  defstruct [:id, :email, :active]

  @default_role :member

  @doc "Fetches a user."
  @spec fetch(integer) :: term
  def fetch(id) when is_integer(id) do
    Repo.get(User, id)
  end

  def fetch(id, opts) do
    {id, opts}
  end

  def handle(:created), do: :ok
  def handle(:deleted), do: :ok

  defp normalize(email) do
    String.downcase(email)
  end

  defmacro __using__(_opts) do
    quote do: import(MyApp.Accounts)
  end

  defmodule Nested do
    def inner(x), do: x
  end
end
`,
    );

    // Every line of the module belongs to a declaration, so the reviewer never
    // meets an anonymous card holding a definition body or a stray `end`.
    expect(anonymousUnits(units)).toEqual([]);
    expect(placedShape(units)).toEqual([
      "1-35 module MyApp.Accounts",
      "7-7 class %MyApp.Accounts{}",
      "11-15 function MyApp.Accounts.fetch/1",
      "17-19 function MyApp.Accounts.fetch/2",
      "21-22 function MyApp.Accounts.handle/1",
      "24-26 function MyApp.Accounts.normalize/1 (private)",
      "28-30 function MyApp.Accounts.__using__/1",
      "32-34 module MyApp.Accounts.Nested",
      "33-33 function MyApp.Accounts.Nested.inner/1",
    ]);
  });

  it("keeps every definition card individually identifiable", () => {
    const units = analyze(
      "lib/my_app/accounts.ex",
      `defmodule MyApp.Accounts do
  @doc "Fetches a user."
  @spec fetch(integer) :: term
  def fetch(id), do: id

  defp fetch(id, :raw), do: id
end
`,
    );

    // Arity and privacy are what tell two same-named Elixir definitions apart,
    // so both belong in the card title or the reviewer cannot pick a card.
    const names = units.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(named(units, "MyApp.Accounts.fetch/1").kind).toBe("function");
    expect(named(units, "MyApp.Accounts.fetch/2 (private)").kind).toBe(
      "function",
    );
    // A signature or documentation edit is a change to the function it
    // describes, so it must land on that function's card.
    expect(named(units, "MyApp.Accounts.fetch/1").source).toContain(
      "@spec fetch(integer) :: term",
    );
  });

  it("reviews a protocol and each implementation as separate cards", () => {
    const units = analyze(
      "lib/my_app/sizeable.ex",
      `defprotocol Sizeable do
  @doc "Returns a size."
  def size(term)
end

defimpl Sizeable, for: List do
  def size(term), do: length(term)
end

defimpl Sizeable, for: Map do
  def size(term), do: map_size(term)
end
`,
    );

    // Implementations of one protocol define the same function names, so the
    // implemented type has to appear in every title to keep the cards apart.
    expect(placedShape(units)).toEqual([
      "1-4 class Sizeable",
      "2-3 function Sizeable.size/1",
      "6-8 class Sizeable.List",
      "7-7 function Sizeable.List.size/1",
      "10-12 class Sizeable.Map",
      "11-11 function Sizeable.Map.size/1",
    ]);
  });

  it("names ExUnit cases by their describe and module context", () => {
    const units = analyze(
      "test/my_app/accounts_test.exs",
      `defmodule MyApp.AccountsTest do
  use ExUnit.Case, async: true

  setup_all do
    :ok
  end

  setup do
    {:ok, user: build(:user)}
  end

  test "fetches a user", %{user: user} do
    assert MyApp.Accounts.fetch(user.id)
  end

  describe "normalize/1" do
    test "downcases" do
      assert true
    end
  end
end
`,
    );

    // Test names repeat across describe blocks and across suites in one file,
    // so a card title only identifies a case when it carries its full path.
    expect(placedShape(units)).toEqual([
      "1-21 test_suite MyApp.AccountsTest",
      "4-6 test_hook MyApp.AccountsTest › setup_all",
      "8-10 test_hook MyApp.AccountsTest › setup",
      "12-14 test MyApp.AccountsTest › fetches a user",
      "16-20 test_suite MyApp.AccountsTest › normalize/1",
      "17-19 test MyApp.AccountsTest › normalize/1 › downcases",
    ]);
  });
});

describe("Clojure review analysis", () => {
  it("splits a namespace into per-form cards instead of one module card", () => {
    const units = analyze(
      "src/myapp/core.clj",
      `(ns myapp.core
  (:require [clojure.string :as str]))

(def default-timeout 30)

(def ^:private secret-key "abc")

;; Trims incoming values.
(defn normalize
  "Normalizes a value."
  [x]
  (str/trim x))

(defn- internal-helper [x]
  (inc x))

(defmacro unless [test body]
  (list 'if (list 'not test) body))

(defroutes app
  (GET "/" [] "hi"))
`,
    );

    expect(anonymousUnits(units)).toEqual([]);
    expect(placedShape(units)).toEqual([
      "1-2 module Namespace myapp.core",
      "4-4 constant default-timeout",
      "6-6 constant secret-key (private)",
      // The comment above a form documents it, so it rides on the form's card.
      "8-12 function normalize",
      "14-15 function internal-helper (private)",
      "17-18 function unless",
      // `defroutes` is an application-defined `def*` macro; it still binds a
      // namespace-level var, so it stays a reviewable card of its own.
      "20-21 variable app",
    ]);
  });

  it("reviews record and protocol members as cards inside their type", () => {
    const units = analyze(
      "src/myapp/duck.clj",
      `(defprotocol Quacker
  (quack [this] "Quacks.")
  (fly [this] [this height]))

(defrecord Duck [sound]
  Quacker
  (quack [this] sound)
  (fly [this height] height))
`,
    );

    // A protocol and its implementing record declare the same member names, so
    // the owning type must prefix each member card.
    expect(placedShape(units)).toEqual([
      "1-3 class Quacker",
      "2-2 method Quacker.quack",
      "3-3 method Quacker.fly",
      "5-8 class Duck",
      "7-7 method Duck.quack",
      "8-8 method Duck.fly",
    ]);
  });

  it("labels multimethod implementations with their dispatch value", () => {
    const units = analyze(
      "src/myapp/area.clj",
      `(defmulti area :shape)

(defmethod area :circle [s]
  (* Math/PI (:r s) (:r s)))

(defmethod area :square [s]
  (* (:side s) (:side s)))
`,
    );

    // Every implementation of one multimethod shares the multimethod name, so
    // only the dispatch value can tell the cards apart.
    expect(placedShape(units)).toEqual([
      "1-1 function area",
      "3-4 method area :circle",
      "6-7 method area :square",
    ]);
  });

  it("reviews each clojure.test case as its own card", () => {
    const units = analyze(
      "test/myapp/core_test.clj",
      `(ns myapp.core-test
  (:require [clojure.test :refer :all]))

(deftest normalize-test
  (testing "trims"
    (is (= "a" (normalize " a ")))))

(deftest area-test
  (is (= 1 (area {:shape :square :side 1}))))
`,
    );

    expect(placedShape(units)).toEqual([
      "1-2 module Namespace myapp.core-test",
      "4-6 test normalize-test",
      "8-9 test area-test",
    ]);
  });
});

describe("a declaration rewritten in another form", () => {
  it("reviews a constant that became a function as one change", () => {
    const previousContent = `export const limit = {
  retries: 3,
  timeout: 1000,
};

export function unrelated() {
  return limit;
}
`;
    const content = `export function limit() {
  return {
    retries: 3,
    timeout: 1000,
  };
}

export function unrelated() {
  return limit();
}
`;
    const units = analyzeFiles([
      { path: "a/limit.ts", previousContent, content, changeType: "modified" },
    ]).units.filter(({ kind }) => kind !== "file");

    // The declaration kept its name and its purpose, so a reviewer wants its
    // before and after on one card - not a removal beside an addition that
    // reads as two unrelated changes.
    const rewritten = units.filter(({ name }) => name === "limit");
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.changeType).toBe("modified");
    expect(rewritten[0]?.previousSource).toContain("export const limit");
    expect(rewritten[0]?.source).toContain("export function limit()");
  });

  it("keeps a differently named rewrite as two changes", () => {
    const previousContent = `export const alpha = {
  retries: 3,
};
`;
    const content = `export function beta() {
  return 3;
}
`;
    const units = analyzeFiles([
      { path: "a/pair.ts", previousContent, content, changeType: "modified" },
    ]).units.filter(({ kind }) => kind !== "file");

    // Neither the name nor the kind carries over, so nothing identifies these
    // as the same declaration and they stay two separate changes.
    expect(units.map(({ name }) => name).sort()).toEqual(["alpha", "beta"]);
  });
});
