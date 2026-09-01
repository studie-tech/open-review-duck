import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { reviewUnits, signOffs, users } from "@/drizzle/schema";
import type { db as database } from "~/server/db";

/** Calculates experience awarded for a completed review unit. */
export function reviewExperience(complexity: number, durationSeconds: number) {
  return Math.min(
    75,
    5 + complexity * 3 + Math.round(Math.min(durationSeconds, 600) / 30),
  );
}

/** Recalculates review achievements and streaks from persisted activity. */
export async function recomputeReviewStats(
  tx: Parameters<Parameters<(typeof database)["transaction"]>[0]>[0],
  userId: string,
) {
  const events = tx
    .selectDistinct({
      semanticHash: signOffs.semanticHash,
      signedOffAt: signOffs.signedOffAt,
      durationSeconds: signOffs.durationSeconds,
      complexity: reviewUnits.complexity,
    })
    .from(signOffs)
    .innerJoin(reviewUnits, eq(signOffs.unitId, reviewUnits.id))
    .where(and(eq(signOffs.userId, userId), isNull(signOffs.invalidatedAt)))
    .as("events");
  // A reviewer's sign-off history only ever grows, so Postgres aggregates it
  // and only one row per review day crosses the wire. The experience sum
  // mirrors reviewExperience so the stored total matches the per-unit awards,
  // and the totals ride along as window values on every day row to keep the
  // whole recomputation to a single statement.
  const rows = await tx
    .selectDistinct({
      day: sql<number>`
        extract(
          epoch from date_trunc('day', ${events.signedOffAt} at time zone 'utc')
        ) * 1000
      `.mapWith(Number),
      experiencePoints: sql<number>`
        sum(
          least(
            75,
            5 + ${events.complexity} * 3
              + round(least(${events.durationSeconds}, 600) / 30.0)
          )
        ) over ()
      `.mapWith(Number),
      lastReviewDate: sql<Date>`max(${events.signedOffAt}) over ()`.mapWith(
        signOffs.signedOffAt,
      ),
    })
    .from(events);
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const reviewDays = rows.map(({ day }) => day).sort((a, b) => a - b);
  let runningStreak = 0;
  let longestStreak = 0;
  let previousDay: number | undefined;
  for (const day of reviewDays) {
    runningStreak = previousDay === day - 86_400_000 ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousDay = day;
  }
  const latestDay = reviewDays.at(-1);
  const currentStreak =
    latestDay === today || latestDay === today - 86_400_000 ? runningStreak : 0;
  const totals = rows.at(0);
  const lastReviewDate = totals?.lastReviewDate ?? null;
  const experiencePoints = totals?.experiencePoints ?? 0;

  await tx
    .update(users)
    .set({
      experiencePoints,
      currentStreak,
      longestStreak,
      lastReviewDate,
    })
    .where(eq(users.id, userId));
}
