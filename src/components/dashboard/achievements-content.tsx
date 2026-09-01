"use client";

import { Award, Check, Clock3, Flame, Star } from "lucide-react";
import { PageContainer } from "~/components/page-container";
import { hydratedQueryOptions } from "~/lib/hydration-clock";
import { api, type RouterOutputs } from "~/trpc/react";

type Gamification = RouterOutputs["review"]["gamification"];

/** Renders review achievements from automatically refreshed progress data. */
export function AchievementsContent({
  initialStats,
  fetchedAt,
}: {
  initialStats: Gamification;
  fetchedAt: number;
}) {
  const progress = api.review.gamification.useQuery(
    undefined,
    hydratedQueryOptions(initialStats, fetchedAt),
  );
  const stats = progress.data ?? initialStats;
  const achievements = [
    {
      title: "First principles",
      description: "Sign off on your first review unit",
      progress: Math.min(stats.totalSignOffs, 1),
      target: 1,
      icon: Check,
    },
    {
      title: "Dependency diver",
      description: "Understand 50 individual symbols",
      progress: Math.min(stats.totalSignOffs, 50),
      target: 50,
      icon: Star,
    },
    {
      title: "Sustained attention",
      description: "Build a seven-day review streak",
      progress: Math.min(stats.longestStreak, 7),
      target: 7,
      icon: Flame,
    },
    {
      title: "Deep reviewer",
      description: "Spend two focused hours reviewing",
      progress: Math.min(Math.floor(stats.reviewSeconds / 60), 120),
      target: 120,
      icon: Clock3,
    },
  ];

  return (
    <PageContainer>
      <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
        Progress
      </p>
      <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em]">
        Build a review practice
      </h1>
      <p className="text-mist mt-2 text-sm">
        Rewards recognize careful attention—not speed, volume, or rubber
        stamping.
      </p>

      <section className="mt-9 grid gap-4 sm:grid-cols-3">
        {[
          ["Current streak", `${stats.currentStreak} days`, Flame],
          ["Experience", `${stats.experiencePoints} XP`, Award],
          ["Units understood", String(stats.totalSignOffs), Check],
        ].map(([label, value, Icon]) => {
          const StatIcon = Icon as typeof Award;
          return (
            <article
              key={String(label)}
              className="bg-surface rounded-2xl border border-line p-5 shadow-[0_14px_40px_var(--app-shadow)]"
            >
              <StatIcon className="text-lime size-4" />
              <p className="text-mist mt-6 text-xs">{String(label)}</p>
              <p className="mt-2 text-2xl font-semibold">{String(value)}</p>
            </article>
          );
        })}
      </section>

      <section className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {achievements.map(
          ({ title, description, progress: value, target, icon: Icon }) => {
            const completed = value >= target;
            return (
              <article
                key={title}
                className="bg-surface/70 rounded-2xl border border-line p-6"
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`grid size-10 place-items-center rounded-xl ${
                      completed
                        ? "bg-lime text-accent-foreground"
                        : "text-mist bg-surface-subtle"
                    }`}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="text-fog font-mono text-xs">
                    {value}/{target}
                  </span>
                </div>
                <h2 className="mt-5 text-sm font-medium">{title}</h2>
                <p className="text-mist mt-2 text-xs">{description}</p>
                <div className="bg-surface-subtle mt-5 h-1.5 overflow-hidden rounded-full">
                  <div
                    role="progressbar"
                    aria-label={`${title} progress`}
                    aria-valuemin={0}
                    aria-valuemax={target}
                    aria-valuenow={value}
                    className="bg-lime h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (value / target) * 100)}%`,
                    }}
                  />
                </div>
              </article>
            );
          },
        )}
      </section>
    </PageContainer>
  );
}
