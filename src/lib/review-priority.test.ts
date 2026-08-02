import { describe, expect, it } from "vitest";
import { reviewFoundationPriority } from "./review-priority";

describe("reviewFoundationPriority", () => {
  it.each([
    [
      "drizzle/schema.ts",
      "users",
      "constant",
      "export const users = pgTable('users', {});",
    ],
    [
      "domain/user.py",
      "User",
      "class",
      "@dataclass\nclass User:\n    name: str",
    ],
    ["src/User.java", "User", "class", "@Entity\npublic class User {}"],
    [
      "include/user.h",
      "User",
      "class",
      "typedef struct User { int id; } User;",
    ],
    ["api/schema.graphql", "schema.graphql", "module", "type User { id: ID! }"],
    [
      "db/migrations/001.sql",
      "001.sql",
      "module",
      "CREATE TABLE users (id int);",
    ],
    [
      "app/models/user.py",
      "User",
      "class",
      "class User(models.Model):\n    email = models.EmailField()",
    ],
    [
      "infra/variables.tf",
      "service_config",
      "variable",
      'variable "service_config" { type = object({ port = number }) }',
    ],
  ] as const)("recognizes %s as foundational", (path, name, kind, source) => {
    expect(
      reviewFoundationPriority({ path, name, kind, source }),
    ).toMatchObject({ foundation: true });
  });

  it("does not promote behavioral classes or ordinary configuration", () => {
    expect(
      reviewFoundationPriority({
        path: "src/services/user-service.ts",
        name: "UserService",
        kind: "class",
        source: "class UserService { save() { return true; } }",
      }),
    ).toEqual({ rank: 2, foundation: false });
    expect(
      reviewFoundationPriority({
        path: "config/settings.json",
        name: "settings.json",
        kind: "module",
        source: '{ "enabled": true }',
      }),
    ).toEqual({ rank: 2, foundation: false });
  });
});
