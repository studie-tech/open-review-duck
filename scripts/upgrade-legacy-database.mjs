const DUPLICATE_OBJECT_CODES = new Set(["42710", "42P07"]);
const FIRST_PASS_SKIPPABLE_CODES = new Set([
  ...DUPLICATE_OBJECT_CODES,
  "42703",
]);
const LEGACY_UPGRADE_LOCK_KEY = 4_182_339_001;

/** Returns whether a table or column from the pre-platform schema is present. */
async function legacySchemaDetected(client, baseline) {
  const schemaState = await client.query(
    `select
       to_regclass('public.open_review_duck_ai_configuration') is not null as legacy,
       to_regclass('drizzle.__drizzle_migrations') is not null as journal_exists`,
  );

  if (
    schemaState.rows[0]?.legacy !== true ||
    schemaState.rows[0]?.journal_exists !== true
  ) {
    return false;
  }

  const result = await client.query(
    `select exists (
       select 1
       from drizzle.__drizzle_migrations
       where hash = $1 or created_at = $2
     ) as baseline_applied`,
    [baseline.hash, baseline.folderMillis],
  );
  return result.rows[0]?.baseline_applied !== true;
}

/** Applies baseline statements while tolerating objects already owned by the legacy schema. */
async function applyBaselinePass(client, baseline, skippableCodes) {
  for (const statement of baseline.sql) {
    await client.query("savepoint legacy_baseline_statement");
    try {
      await client.query(statement);
      await client.query("release savepoint legacy_baseline_statement");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        skippableCodes.has(error.code)
      ) {
        await client.query("rollback to savepoint legacy_baseline_statement");
        await client.query("release savepoint legacy_baseline_statement");
        continue;
      }
      throw error;
    }
  }
}

/** Returns whether one legacy column exists before a data-preserving conversion. */
async function columnExists(client, table, column) {
  const result = await client.query(
    `select exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = $1
         and column_name = $2
     ) as exists`,
    [table, column],
  );
  return result.rows[0]?.exists === true;
}

/** Adds columns introduced when the original migration history became a new baseline. */
async function addLegacyColumns(client) {
  await client.query(`
    alter type "ai_job_status" add value if not exists 'waiting_for_provider';
    alter type "ai_job_status" add value if not exists 'streaming';
    alter type "ai_job_status" add value if not exists 'cancelled';

    alter table "open_review_duck_ai_job"
      add column if not exists "workflowRunId" uuid,
      add column if not exists "progress" integer default 0 not null,
      add column if not exists "completionReason" "ai_completion_reason",
      add column if not exists "model" varchar(255),
      add column if not exists "provider" varchar(64),
      add column if not exists "parentJobId" uuid,
      add column if not exists "ruleConfigDigest" varchar(64),
      add column if not exists "deepReviewTerminalState" "deep_review_terminal_state",
      add column if not exists "runFailureClass" "review_failure_class",
      add column if not exists "reservedMicroUsd" bigint default 0 not null,
      add column if not exists "actualMicroUsd" bigint default 0 not null,
      add column if not exists "startedAt" timestamp with time zone,
      add column if not exists "cancelledAt" timestamp with time zone;

    alter table "open_review_duck_provider_connection"
      add column if not exists "credentialKind" varchar(32) default 'local_pat' not null,
      add column if not exists "installationId" text,
      add column if not exists "localCredentialId" uuid;

    alter table "open_review_duck_repository"
      add column if not exists "workspaceId" uuid,
      add column if not exists "reviewIntakeMode" "repository_intake_mode" default 'manual' not null,
      add column if not exists "intakeLastAttemptAt" timestamp with time zone,
      add column if not exists "intakeLastReconciledAt" timestamp with time zone,
      add column if not exists "intakeLastError" text,
      add column if not exists "intakeOwnerId" text,
      add column if not exists "pullRequestStateLastCheckedAt" timestamp with time zone,
      add column if not exists "pullRequestStateLastError" text;
    update "open_review_duck_repository" repository
    set "workspaceId" = connection."workspaceId"
    from "open_review_duck_provider_connection" connection
    where repository."connectionId" = connection."id"
      and repository."workspaceId" is null;

    alter table "open_review_duck_review_unit"
      add column if not exists "snapshotFileId" uuid,
      add column if not exists "currentBlobId" uuid,
      add column if not exists "previousBlobId" uuid,
      add column if not exists "startByte" integer default 0 not null,
      add column if not exists "endByte" integer default 0 not null,
      add column if not exists "previousStartByte" integer,
      add column if not exists "previousEndByte" integer,
      add column if not exists "relatedRanges" jsonb;
  `);

  if (
    await columnExists(
      client,
      "open_review_duck_provider_connection",
      "credentialFingerprint",
    )
  ) {
    await client.query(`
      alter table "open_review_duck_provider_connection"
        alter column "credentialFingerprint" drop not null;
    `);
  }

  const unresolvedRepositories = await client.query(`
    select
      "id",
      "connectionId",
      (count(*) over ())::integer as "unresolvedCount"
    from "open_review_duck_repository"
    where "workspaceId" is null
    order by "id"
    limit 10
  `);
  if (unresolvedRepositories.rows.length > 0) {
    const count = unresolvedRepositories.rows[0].unresolvedCount;
    const examples = unresolvedRepositories.rows
      .map(
        ({ id, connectionId }) =>
          `${id} (connection ${connectionId ?? "missing"})`,
      )
      .join(", ");
    throw new Error(
      `Legacy database schema upgrade found ${count} repositories without a workspace: ${examples}`,
    );
  }
  await client.query(`
    alter table "open_review_duck_repository"
      alter column "workspaceId" set not null;
  `);
}

/** Preserves legacy OAuth credentials and dashboard preferences in their new tables. */
async function migrateLegacyRows(client) {
  if (
    await columnExists(
      client,
      "open_review_duck_provider_connection",
      "encryptedAccessToken",
    )
  ) {
    await client.query(`
      insert into "open_review_duck_oauth_credential" (
        "connectionId",
        "encryptedAccessToken",
        "encryptedRefreshToken",
        "expiresAt",
        "createdAt",
        "updatedAt"
      )
      select
        "id",
        "encryptedAccessToken",
        "encryptedRefreshToken",
        "expiresAt",
        "createdAt",
        "updatedAt"
      from "open_review_duck_provider_connection"
      where "encryptedAccessToken" is not null
      on conflict ("connectionId") do nothing;

      update "open_review_duck_provider_connection"
      set "credentialKind" = 'oauth'
      where "encryptedAccessToken" is not null;
    `);
  }

  const hasLegacyAiPreferences =
    (await columnExists(client, "open_review_duck_workspace", "aiMode")) &&
    (await columnExists(
      client,
      "open_review_duck_workspace",
      "aiReviewEnabled",
    ));
  if (hasLegacyAiPreferences) {
    await client.query(`
      insert into "open_review_duck_ai_preference" (
        "workspaceId",
        "mode",
        "reviewPullRequests"
      )
      select "id", "aiMode", "aiReviewEnabled"
      from "open_review_duck_workspace"
      on conflict ("workspaceId") do nothing;
    `);
  }

  // The legacy dashboard showed every open or draft pull request to every
  // workspace member. Seed exactly those users so the new personal queue keeps
  // the previous dashboard behavior without surfacing completed pull requests.
  await client.query(`
    insert into "open_review_duck_review_queue_item" (
      "pullRequestId",
      "userId",
      "state",
      "source"
    )
    select pull_request."id", member."userId", 'active', 'manual'
    from "open_review_duck_pull_request" pull_request
    inner join "open_review_duck_repository" repository
      on repository."id" = pull_request."repositoryId"
    inner join "open_review_duck_workspace_member" member
      on member."workspaceId" = repository."workspaceId"
    where pull_request."state" in ('open', 'draft')
    on conflict ("pullRequestId", "userId") do nothing;
  `);
}

/** Upgrades databases created before the production-platform baseline without dropping data. */
export async function upgradeLegacyDatabase(
  client,
  migrations,
  { dryRun = false } = {},
) {
  const baseline = migrations[0];
  if (!baseline || !(await legacySchemaDetected(client, baseline))) {
    return false;
  }

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1)", [
      LEGACY_UPGRADE_LOCK_KEY,
    ]);
    if (!(await legacySchemaDetected(client, baseline))) {
      await client.query("rollback");
      return false;
    }
    await applyBaselinePass(client, baseline, FIRST_PASS_SKIPPABLE_CODES);
    await addLegacyColumns(client);
    await migrateLegacyRows(client);
    await applyBaselinePass(client, baseline, DUPLICATE_OBJECT_CODES);
    await client.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at)
       select $1, $2
       where not exists (
         select 1
         from drizzle.__drizzle_migrations
         where hash = $1 or created_at = $2
       )`,
      [baseline.hash, baseline.folderMillis],
    );
    await client.query(dryRun ? "rollback" : "commit");
    return true;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Keep the upgrade failure as the actionable cause.
    }
    throw error;
  }
}
