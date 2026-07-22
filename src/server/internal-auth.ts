import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "~/env";

/** Compares an internal maintenance credential without timing leakage. */
export function authorizedInternalRequest(request: NextRequest) {
  const received = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  const expected = env.CRON_SECRET ?? env.FLUE_INTERNAL_SECRET;
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
