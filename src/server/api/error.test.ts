import { describe, expect, it } from "vitest";
import { internalErrorDetails, publicTrpcErrorMessage } from "./error";

describe("tRPC error safety", () => {
  it("replaces unexpected implementation details with stable public copy", () => {
    expect(
      publicTrpcErrorMessage(
        "INTERNAL_SERVER_ERROR",
        "Failed query: insert into provider_connection params: private",
      ),
    ).toBe("ReviewDuck could not complete this request. Please try again.");
    expect(publicTrpcErrorMessage("BAD_REQUEST", "Token was rejected")).toBe(
      "Token was rejected",
    );
  });

  it("keeps structural database diagnostics without the failed query", () => {
    const databaseError = Object.assign(new Error("private database detail"), {
      code: "23502",
      table: "open_review_duck_provider_connection",
      column: "encryptedAccessToken",
    });
    const queryError = new Error(
      "Failed query: insert into provider_connection params: private",
      { cause: databaseError },
    );

    expect(internalErrorDetails(queryError)).toEqual({
      name: "Error",
      code: "23502",
      constraint: undefined,
      table: "open_review_duck_provider_connection",
      column: "encryptedAccessToken",
    });
  });
});
