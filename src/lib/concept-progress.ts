export type ConceptStatus = "changed" | "partial" | "pending" | "signed_off";

/**
 * Derives a concept's standing from the atomic units it groups.
 *
 * The units are the ledger; a concept is only ever a reading of them. A
 * concept whose members are all signed off is therefore closed no matter how
 * they were signed off — one at a time, in a batch of deleted files, or
 * carried across a resync — and a concept the snapshot no longer has members
 * for has nothing left to ask of the reviewer either. A wait is a property of
 * one unit's conversation, so a member awaiting a response does not pause the
 * concept or hide its remaining work.
 */
export function conceptStatusFromMembers<Member extends { status: string }>(
  members: readonly Member[],
  claimedMemberCount = members.length,
): ConceptStatus {
  if (claimedMemberCount === 0) return "pending";
  const signed = members.filter(({ status }) => status === "signed_off").length;
  if (signed === members.length) return "signed_off";
  // Code that changed after a sign-off outranks the progress around it: a
  // member that came back is work the reviewer already believed was done, and
  // reading it as ordinary partial progress hides that it needs a second look.
  if (members.some(({ status }) => status === "changed")) return "changed";
  if (signed > 0) return "partial";
  return "pending";
}
