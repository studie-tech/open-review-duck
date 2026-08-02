import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { isTrpcNotFoundError } from "./trpc-errors";

describe("isTrpcNotFoundError", () => {
  it("distinguishes missing resources from infrastructure failures", () => {
    expect(isTrpcNotFoundError(new TRPCError({ code: "NOT_FOUND" }))).toBe(
      true,
    );
    expect(
      isTrpcNotFoundError(new TRPCError({ code: "INTERNAL_SERVER_ERROR" })),
    ).toBe(false);
    expect(isTrpcNotFoundError(new Error("connection timeout"))).toBe(false);
  });
});
