import type { Instrumentation } from "next";

/** Initializes the selected durable world and SaaS-only observability. */
export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.DEPLOYMENT_MODE === "local"
  ) {
    // This explicit import makes the complete Postgres World part of the
    // standalone trace; getWorld selects it through WORKFLOW_TARGET_WORLD.
    await import("@workflow/world-postgres");
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
  }
  if (process.env.DEPLOYMENT_MODE !== "saas" || !process.env.SENTRY_DSN) {
    return;
  }
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/** Redacts and forwards one Next.js request failure in SaaS deployments. */
export const onRequestError: Instrumentation.onRequestError = async (
  ...arguments_
) => {
  if (process.env.DEPLOYMENT_MODE !== "saas") return;
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...arguments_);
};
