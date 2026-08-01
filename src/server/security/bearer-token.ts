import { timingSafeEqual } from "node:crypto";

/** Compares a bearer authorization header without leaking token prefixes. */
export function hasBearerToken(
  authorization: string | null,
  expectedToken: string | undefined,
) {
  if (!authorization || !expectedToken) return false;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
