import { access, constants } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { env } from "~/env";
import { workflowUsesApplicationDatabase } from "~/lib/deployment";
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
    const result = await db.execute<{ ready: boolean }>(
      sql`select
        to_regclass('drizzle.__drizzle_migrations') is not null
        and to_regclass('public.open_review_duck_ai_preference') is not null
        and to_regclass('public.open_review_duck_review_queue_item') is not null
        and to_regclass('public.open_review_duck_provider_pat_credential') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'open_review_duck_provider_connection'
            and column_name = 'credentialStatus'
        )
        and not exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'open_review_duck_provider_connection'
            and column_name = 'encryptedAccessToken'
        )
        as ready`,
    );
    checks.migrations = result.rows[0]?.ready === true;
  } catch {
    checks.migrations = false;
  }
  if (workflowUsesApplicationDatabase(process.env.WORKFLOW_TARGET_WORLD)) {
    try {
      const result = await db.execute<{ exists: boolean }>(
        sql`select to_regclass('workflow.workflow_runs') is not null as exists`,
      );
      checks.workflow = result.rows[0]?.exists === true;
    } catch {
      checks.workflow = false;
    }
  } else {
    // Vercel supplies its managed Workflow world outside the application database.
    checks.workflow = true;
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
