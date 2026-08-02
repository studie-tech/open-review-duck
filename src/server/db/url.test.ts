import { describe, expect, it } from "vitest";
import { normalizeNodePostgresUrl } from "./url";

describe("normalizeNodePostgresUrl", () => {
  it("uses Node's trust store for the libpq system sentinel", () => {
    expect(
      normalizeNodePostgresUrl(
        "postgresql://user:secret@example.com/app?sslmode=verify-full&sslrootcert=system",
      ),
    ).toBe("postgresql://user:secret@example.com/app?sslmode=verify-full");
  });

  it("preserves explicit certificate paths", () => {
    const connectionString =
      "postgresql://user:secret@example.com/app?sslrootcert=%2Fcerts%2Fca.pem";

    expect(normalizeNodePostgresUrl(connectionString)).toBe(connectionString);
  });

  it("uses PlanetScale's pooled application endpoint", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user:secret@us-east-5.pg.psdb.cloud:5432/reviewduck?sslmode=verify-full",
    );

    expect(new URL(normalized).port).toBe("6432");
  });

  it("does not rewrite ports for other PostgreSQL providers", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user:secret@database.example.com:5432/reviewduck",
    );

    expect(new URL(normalized).port).toBe("5432");
  });
});
