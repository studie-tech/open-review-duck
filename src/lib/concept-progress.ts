export type ConceptStatus =
  | "changed"
  | "partial"
  | "pending"
  | "signed_off"
  | "waiting";

/**
 * Derives a concept's standing from the atomic units it groups.
 *
 * The units are the ledger; a concept is only ever a reading of them. A
 * concept whose members are all signed off is therefore closed no matter how
 * they were signed off — one at a time, in a batch of deleted files, or
 * carried across a resync — and a concept the snapshot no longer has members
 * for has nothing left to ask of the reviewer either.
 */
export function conceptStatusFromMembers<Member extends { status: string }>(
  members: readonly Member[],
  claimedMemberCount = members.length,
): ConceptStatus {
  if (claimedMemberCount === 0) return "pending";
  const signed = members.filter(({ status }) => status === "signed_off").length;
  if (members.some(({ status }) => status === "waiting")) return "waiting";
  if (signed === members.length) return "signed_off";
  if (signed > 0) return "partial";
  if (members.some(({ status }) => status === "changed")) return "changed";
  return "pending";
}
