/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for compilation-only CI builds.
 */
import "./src/env.js";
import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import { withWorkflow } from "workflow/next";

const deploymentMode =
  process.env.DEPLOYMENT_MODE === "local" ? "local" : "saas";

/** @type {import("next").NextConfig} */
const config = {
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    cpus: 4,
  },
  output: "standalone",
  outputFileTracingExcludes: {
    "/api/*": ["**/route_client-reference-manifest.js"],
  },
  pageExtensions: [
    "shared.tsx",
    "shared.ts",
    `${deploymentMode}.tsx`,
    `${deploymentMode}.ts`,
    "js",
  ],
  productionBrowserSourceMaps: false,
  serverExternalPackages: ["web-tree-sitter"],
  webpack(webpackConfig) {
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      "~": path.resolve("src"),
      "@/drizzle": path.resolve("drizzle"),
      "reviewduck-deployment-proxy$": path.resolve(
        `src/server/request-proxy.${deploymentMode}.ts`,
      ),
    };
    if (deploymentMode === "local") {
      webpackConfig.resolve.alias = {
        ...webpackConfig.resolve.alias,
        "@aws-sdk/client-kms$": false,
        "@clerk/nextjs$": false,
        "@clerk/nextjs/server$": false,
        "@sentry/nextjs$": false,
        "uploadthing/next$": false,
        "uploadthing/server$": false,
      };
    }
    return webpackConfig;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

const workflowConfig = withWorkflow(config);

export default deploymentMode === "local"
  ? workflowConfig
  : withSentryConfig(workflowConfig, {
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: !process.env.CI,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
      bundleSizeOptimizations: {
        excludeDebugStatements: true,
        excludeTracing: false,
      },
      telemetry: false,
    });
