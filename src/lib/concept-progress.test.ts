import { describe, expect, it } from "vitest";
import { conceptStatusFromMembers } from "./concept-progress";

/** Builds the member list one concept status is read from. */
function members(...statuses: string[]) {
  return statuses.map((status) => ({ status }));
}

describe("concept status", () => {
  it("closes a concept once every member is signed off", () => {
    expect(conceptStatusFromMembers(members("signed_off", "signed_off"))).toBe(
      "signed_off",
    );
  });

  it("closes a concept whose members were signed off elsewhere", () => {
    // Signing off deleted files, or a resync carrying sign-offs across, can
    // account for every member of a concept the reviewer never opened.
    expect(
      conceptStatusFromMembers(members("signed_off", "signed_off"), 2),
    ).toBe("signed_off");
  });

  it("closes a concept the snapshot no longer holds members for", () => {
    expect(conceptStatusFromMembers([], 3)).toBe("signed_off");
  });

  it("leaves a concept that never claimed a member pending", () => {
    expect(conceptStatusFromMembers([], 0)).toBe("pending");
  });

  it("waits on a concept with any member awaiting a response", () => {
    expect(conceptStatusFromMembers(members("signed_off", "waiting"))).toBe(
      "waiting",
    );
  });

  it("reports partial progress while work remains", () => {
    expect(conceptStatusFromMembers(members("signed_off", "pending"))).toBe(
      "partial",
    );
  });

  it("reports a member that came back ahead of the progress around it", () => {
    // Partial progress would read as ordinary unfinished work and hide that
    // one member is code the reviewer already signed off on.
    expect(conceptStatusFromMembers(members("signed_off", "changed"))).toBe(
      "changed",
    );
    expect(
      conceptStatusFromMembers(members("signed_off", "changed", "pending")),
    ).toBe("changed");
  });

  it("waits on a returning concept whose member is also awaiting a response", () => {
    expect(conceptStatusFromMembers(members("changed", "waiting"))).toBe(
      "waiting",
    );
  });

  it("reports code that changed after a sign-off", () => {
    expect(conceptStatusFromMembers(members("changed", "pending"))).toBe(
      "changed",
    );
    expect(conceptStatusFromMembers(members("pending", "pending"))).toBe(
      "pending",
    );
  });
});
