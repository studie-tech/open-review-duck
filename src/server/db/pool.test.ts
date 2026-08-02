import { describe, expect, it } from "vitest";
import { nodePostgresPoolConfig } from "./pool";

describe("nodePostgresPoolConfig", () => {
  it("uses a client query timeout without unsupported startup parameters", () => {
    const config = nodePostgresPoolConfig({
      connectionString:
        "postgresql://user:secret@us-east-5.pg.psdb.cloud:5432/reviewduck?sslmode=verify-full",
      connectionTimeoutMillis: 5_000,
      max: 5,
      queryTimeoutMillis: 120_000,
    });

    expect(config.query_timeout).toBe(120_000);
    expect(config).not.toHaveProperty("statement_timeout");
    expect(new URL(String(config.connectionString)).port).toBe("6432");
  });

  it("retains web-pool lifecycle settings", () => {
    expect(
      nodePostgresPoolConfig({
        connectionString:
          "postgresql://user:secret@database.example.com/reviewduck",
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 20_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        max: 2,
        queryTimeoutMillis: 20_000,
      }),
    ).toMatchObject({
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 20_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      max: 2,
      query_timeout: 20_000,
    });
  });
});
