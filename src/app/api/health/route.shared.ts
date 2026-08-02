import { access, constants } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { env } from "~/env";
import { db } from "~/server/db";
import { isLocalDeployment } from "~/server/deployment";

export const dynamic = "force-dynamic";

/** Reports application, database, workflow, migration, and local-disk readiness. */
export async function GET() {
  const checks: Record<string, boolean> = { application: true };
  try {
    await db.execute(sql`select 1`);
    checks.postgres = true;
  } catch {
    checks.postgres = false;
  }
  try {
    const result = await db.execute<{ exists: boolean }>(
      sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
    );
    checks.migrations = result.rows[0]?.exists === true;
  } catch {
    checks.migrations = false;
  }
  try {
    const result = await db.execute<{ exists: boolean }>(
      sql`select to_regclass('workflow.workflow_runs') is not null as exists`,
    );
    checks.workflow = result.rows[0]?.exists === true;
  } catch {
    checks.workflow = false;
  }
  if (isLocalDeployment()) {
    try {
      await access(path.join(env.LOCAL_DATA_DIR, "objects"), constants.W_OK);
      checks.storage = true;
    } catch {
      checks.storage = false;
    }
  }
  const healthy = Object.values(checks).every(Boolean);
  return NextResponse.json(
    { healthy, checks },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
