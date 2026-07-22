import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { users } from "@/drizzle/schema";
import { env } from "~/env";
import { db } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";

/** Verifies and applies Clerk account lifecycle events to local user state. */
export async function POST(request: NextRequest) {
  if (isLocalDeployment() || !env.CLERK_WEBHOOK_SIGNING_SECRET) {
    return new NextResponse(null, { status: 404 });
  }
  let event: Awaited<
    ReturnType<typeof import("@clerk/nextjs/webhooks")["verifyWebhook"]>
  >;
  try {
    const { verifyWebhook } = await import("@clerk/nextjs/webhooks");
    event = await verifyWebhook(request, {
      signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  if (event.type === "user.created" || event.type === "user.updated") {
    const primaryEmail = event.data.email_addresses.find(
      ({ id }) => id === event.data.primary_email_address_id,
    )?.email_address;
    const fullName = [event.data.first_name, event.data.last_name]
      .filter(Boolean)
      .join(" ");
    const displayName =
      fullName.length > 0
        ? fullName
        : (primaryEmail?.split("@")[0] ?? "Reviewer");
    await db
      .insert(users)
      .values({
        id: event.data.id,
        email: primaryEmail,
        displayName,
        imageUrl: event.data.image_url,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: primaryEmail,
          displayName,
          imageUrl: event.data.image_url,
        },
      });
  }
  if (event.type === "user.deleted" && event.data.id) {
    await db.delete(users).where(eq(users.id, event.data.id));
  }
  return NextResponse.json({ received: true });
}
