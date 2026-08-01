import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { localBootstrapTokens, localSessions } from "@/drizzle/schema";
import { env } from "~/env";
import {
  hostnameFromHostHeader,
  isLoopbackHostname,
  LOCAL_SESSION_COOKIE,
  LOCAL_USER_ID,
} from "~/lib/deployment";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

/** Exchanges a one-time local bootstrap capability for an owner session. */
export async function GET(request: Request) {
  const host = request.headers.get("host");
  if (!host || !isLoopbackHostname(hostnameFromHostHeader(host))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token || token.length < 32) {
    return NextResponse.json(
      { error: "Invalid bootstrap token" },
      { status: 400 },
    );
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const sessionToken = randomBytes(48).toString("base64url");
  const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
  const sessionExpiry = new Date(
    Date.now() + env.LOCAL_SESSION_TTL_DAYS * 86_400_000,
  );
  const exchanged = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('reviewduck-local-bootstrap'))`,
    );
    const bootstrap = await tx.query.localBootstrapTokens.findFirst({
      where: and(
        eq(localBootstrapTokens.tokenHash, tokenHash),
        isNull(localBootstrapTokens.consumedAt),
        gt(localBootstrapTokens.expiresAt, new Date()),
      ),
    });
    if (!bootstrap) return false;
    await tx
      .update(localBootstrapTokens)
      .set({ consumedAt: new Date() })
      .where(eq(localBootstrapTokens.id, bootstrap.id));
    await tx.insert(localSessions).values({
      userId: LOCAL_USER_ID,
      tokenHash: sessionHash,
      expiresAt: sessionExpiry,
    });
    return true;
  });
  if (!exchanged) {
    return NextResponse.json(
      { error: "Bootstrap token is expired or already used" },
      { status: 410 },
    );
  }
  const response = NextResponse.redirect(
    new URL("/dashboard", `${url.protocol}//${host}`),
  );
  response.cookies.set(LOCAL_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: url.protocol === "https:",
    path: "/",
    expires: sessionExpiry,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
