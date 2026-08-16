import { execFileSync } from "node:child_process";

const inheritedStdio = { stdio: "inherit" };

// Preview branches can share environment configuration with production. Only
// the deployment that will receive production traffic may advance its schema.
if (process.env.VERCEL_ENV === "production") {
  execFileSync(process.execPath, ["scripts/migrate.mjs"], inheritedStdio);
}

execFileSync("pnpm", ["build"], inheritedStdio);
