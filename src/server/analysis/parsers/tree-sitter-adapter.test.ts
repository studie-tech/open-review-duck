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
