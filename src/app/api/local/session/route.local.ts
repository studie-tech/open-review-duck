import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { localSessions } from "@/drizzle/schema";
import { LOCAL_SESSION_COOKIE } from "~/lib/deployment";
import { db } from "~/server/db";

/** Revokes the current local owner session. */
export async function DELETE(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCAL_SESSION_COOKIE}=`))
    ?.slice(LOCAL_SESSION_COOKIE.length + 1);
  if (token) {
    await db
      .update(localSessions)
      .set({ revokedAt: new Date() })
      .where(
        eq(
          localSessions.tokenHash,
          createHash("sha256").update(token).digest("hex"),
        ),
      );
  }
  const response = NextResponse.json({ revoked: true });
  response.cookies.delete(LOCAL_SESSION_COOKIE);
  return response;
}
