import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./engine";
import type { TreeSitterLanguage } from "./tree-sitter";
import {
  syntaxDescendants,
  withPreparedTreeSitterLanguages,
  withSyntaxTree,
} from "./tree-sitter";

const samples: Array<[TreeSitterLanguage, string, string]> = [
  [
    "sql",
    "a/migrations/0001_reviews.sql",
    `-- Migration 0001: reviews
CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  status review_status NOT NULL DEFAULT 'pending',
  author_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_title_not_blank CHECK (length(title) > 0)
);

CREATE INDEX reviews_author_idx ON reviews (author_id);

ALTER TABLE reviews ADD COLUMN archived_at timestamptz;

CREATE VIEW active_reviews AS
SELECT id, title, status
FROM reviews
WHERE archived_at IS NULL;

CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`,
  ],
  [
    "sql",
    "a/migrations/0002_alter.sql",
    `ALTER TABLE reviews
  ADD CONSTRAINT reviews_status_check CHECK (status IS NOT NULL);

ALTER TABLE reviews DROP COLUMN archived_at;

CREATE UNIQUE INDEX CONCURRENTLY reviews_title_key ON reviews (title);

CREATE TRIGGER reviews_touch
  BEFORE UPDATE ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();

DROP TABLE IF EXISTS legacy_reviews;

INSERT INTO review_settings (key, value)
VALUES ('retention_days', '30');
`,
  ],
  [
    "prisma",
    "a/prisma/schema.prisma",
    `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  MEMBER
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  role      Role     @default(MEMBER)
  posts     Post[]
  createdAt DateTime @default(now())

  @@index([email])
}

model Post {
  id       String @id @default(uuid())
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId String
}
`,
  ],
  [
    "graphql",
    "a/schema.graphql",
    `directive @auth(requires: Role = ADMIN) on FIELD_DEFINITION

schema {
  query: Query
  mutation: Mutation
}

scalar DateTime

enum Role {
  ADMIN
  MEMBER
}

interface Node {
  id: ID!
}

type User implements Node {
  id: ID!
  email: String!
  role: Role! @auth
  posts: [Post!]!
}

union SearchResult = User | Post

input CreateUserInput {
  email: String!
  role: Role = MEMBER
}

type Mutation {
  createUser(input: CreateUserInput!): User!
}
`,
  ],
  [
    "protobuf",
    "a/proto/review.proto",
    `syntax = "proto3";

package review.v1;

import "google/protobuf/timestamp.proto";

enum Status {
  STATUS_UNSPECIFIED = 0;
  STATUS_ACTIVE = 1;
}

message Review {
  string id = 1;
  string title = 2;
  Status status = 3;

  message Author {
    string id = 1;
    string email = 2;
  }

  Author author = 4;

  oneof target {
    string pull_request_url = 5;
    string commit_sha = 6;
  }
}

service ReviewService {
  rpc GetReview(GetReviewRequest) returns (Review);
  rpc ListReviews(ListReviewsRequest) returns (stream Review);
}

message GetReviewRequest {
  string id = 1;
}
`,
  ],
  [
    "json",
    "a/package.json",
    `{
  "name": "open-review-duck",
  "version": "1.2.3",
  "scripts": {
    "build": "next build",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "15.0.0",
    "react": "19.0.0"
  },
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=20" }
}
`,
  ],
  [
    "yaml",
    "a/compose.yaml",
    `version: "3.9"

x-defaults: &defaults
  restart: unless-stopped
  networks:
    - backend

services:
  api:
    <<: *defaults
    image: ghcr.io/acme/api:1.2.3
    environment:
      - DATABASE_URL=postgres://localhost/app
      - NODE_ENV=production
    ports:
      - "3000:3000"
  worker:
    <<: *defaults
    image: ghcr.io/acme/worker:1.2.3
    command: ["node", "worker.js"]

networks:
  backend: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: debug
`,
  ],
  [
    "toml",
    "a/Cargo.toml",
    `title = "Example"

[package]
name = "review-duck"
version = "0.1.0"

[dependencies]
serde = { version = "1", features = ["derive"] }

[[bin]]
name = "duck"
path = "src/main.rs"

[[bin]]
name = "duckling"
path = "src/duckling.rs"

[profile.release]
opt-level = 3
lto = true
`,
  ],
  [
    "xml",
    "a/pom.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>review-duck</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`,
  ],
  [
    "css",
    "a/styles/app.css",
    `:root {
  --brand: #ff8a00;
  --radius: 8px;
}

.card {
  border-radius: var(--radius);
  padding: 16px;
}

.card:hover {
  box-shadow: 0 0 0 2px var(--brand);
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
  to {
    opacity: 1;
  }
}
`,
  ],
  [
    "scss",
    "a/styles/app.scss",
    `@use "sass:color";

$brand: #ff8a00;
$radius: 8px;

@mixin card-surface($padding: 16px) {
  border-radius: $radius;
  padding: $padding;
}

.card {
  @include card-surface;

  &__title {
    font-weight: 600;
  }

  &:hover {
    background: color.adjust($brand, $lightness: 40%);
  }
}

@function double($value) {
  @return $value * 2;
}

@media (max-width: 600px) {
  .card {
    @include card-surface(8px);
  }
}
`,
  ],
  [
    "scss",
    "a/styles/isolate.scss",
    `@media (max-width: 600px) {
  .a {
    padding: 8px;
  }
}

@media (max-width: 600px) {
  .b {
    @include thing(8px);
  }
}

.c {
  color: red;
}

.d {
  @include thing;
}
`,
  ],
  [
    "html",
    "a/public/index.html",
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Review Duck</title>
    <style>
      body {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <header class="site-header">
      <h1>Review Duck</h1>
    </header>
    <main>
      <p>Hello</p>
    </main>
    <script>
      window.addEventListener("load", () => {
        console.log("ready");
      });
    </script>
  </body>
</html>
`,
  ],
  [
    "markdown",
    "a/README.md",
    `# Review Duck

Intro paragraph.

## Installation

Run the installer:

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

### Requirements

- Node 20
- pnpm 9

## Usage

Some usage text.

## License

MIT
`,
  ],
  [
    "dockerfile",
    "a/Dockerfile",
    `# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NODE_ENV=production
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV PORT=3000
COPY --from=builder /app/.next ./.next
EXPOSE 3000
USER node
CMD ["node", "server.js"]
`,
  ],
  [
    "hcl",
    "a/infra/main.tf",
    `terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type        = string
  default     = "eu-west-1"
  description = "Deployment region"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "acme-artifacts"

  tags = {
    Environment = "production"
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

module "network" {
  source = "./modules/network"
  cidr   = "10.0.0.0/16"
}

output "bucket_arn" {
  value = aws_s3_bucket.artifacts.arn
}
`,
  ],
];

describe("probe", () => {
  it("dumps units", async () => {
    const lines: string[] = [];
    for (const [language, path, content] of samples) {
      const result = await withPreparedTreeSitterLanguages([language], () =>
        analyzeFiles([{ path, content, changeType: "added" }]),
      );
      lines.push(`\n### ${language} ${path}`);
      lines.push("--- source ---");
      content.split("\n").forEach((text, index) => {
        lines.push(`  ${String(index + 1).padStart(3)} | ${text}`);
      });
      lines.push("--- units ---");
      for (const unit of [...result.units].sort(
        (l, r) => l.startLine - r.startLine || l.endLine - r.endLine,
      )) {
        lines.push(
          `  ${String(unit.startLine).padStart(3)}-${String(unit.endLine).padStart(3)} ${unit.kind.padEnd(10)} ${unit.name.slice(0, 45).padEnd(45)} depth=${unit.depth} src=${JSON.stringify(unit.source.length > 40 ? `${unit.source.slice(0, 18)}…${unit.source.slice(-18)}` : unit.source)}`,
        );
      }
    }
    writeFileSync("/tmp/probe-data.txt", lines.join("\n"));
    expect(lines.length).toBeGreaterThan(0);
  });

  it("dumps raw adapter units", async () => {
    const { treeSitterAdapter } = await import("./parsers/tree-sitter-adapter");
    const content = `@media (max-width: 600px) {\n  .a {\n    padding: 8px;\n  }\n}\n\n@media (max-width: 600px) {\n  .b {\n    @include thing(8px);\n  }\n}\n\n.c {\n  color: red;\n}\n\n.d {\n  @include thing;\n}\n`;
    const out: string[] = [];
    await withPreparedTreeSitterLanguages(["scss"], () => {
      const adapter = treeSitterAdapter("scss");
      for (const unit of adapter.analyze({
        path: "a/isolate.scss",
        content,
        changeType: "added",
      })) {
        out.push(
          `RAW ${unit.startLine}-${unit.endLine} ${unit.kind} ${unit.name} ctxOnly=${adapter.isContextOnly?.(unit.source)} src=${JSON.stringify(unit.source)}`,
        );
      }
    });
    writeFileSync("/tmp/probe-raw.txt", out.join("\n"));
    expect(out.length).toBeGreaterThan(0);
  });

  it("dumps trees", async () => {
    const out: string[] = [];
    const trees: Array<[TreeSitterLanguage, string]> = [
      [
        "scss",
        `.a {\n  padding: 8px;\n}\n\n.d {\n  @include thing;\n}\n`,
      ],
      [
        "scss",
        `@media (max-width: 600px) {\n  .a {\n    padding: 8px;\n  }\n}\n\n.d {\n  @include thing;\n}\n`,
      ],
      ["protobuf", `service S {\n  rpc A(X) returns (Y);\n}\n`],
      ["toml", `[package]\nname = "x"\n\n[profile.release]\nlto = true\n`],
    ];
    for (const [language, content] of trees) {
      out.push(`\n### ${language}`);
      await withPreparedTreeSitterLanguages([language], () => {
        withSyntaxTree(language, content, (tree) => {
          for (const node of syntaxDescendants(tree.rootNode)) {
            out.push(
              `  ${node.type} [${node.startPosition.row + 1}:${node.startPosition.column}-${node.endPosition.row + 1}:${node.endPosition.column}] ${JSON.stringify(content.slice(node.startIndex, node.endIndex).slice(0, 30))}`,
            );
          }
        });
      });
    }
    writeFileSync("/tmp/probe-trees.txt", out.join("\n"));
    expect(out.length).toBeGreaterThan(0);
  });
});
