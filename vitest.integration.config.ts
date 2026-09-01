import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "server-only": "/src/test/server-only.ts" },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    setupFiles: [
      "./src/test/setup-environment.ts",
      "./src/test/setup-tree-sitter.ts",
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: [
        "src/server/review/queue.ts",
        "src/server/review/queue-policy.ts",
        "src/server/security/rate-limit.ts",
      ],
      exclude: ["**/*.test.ts", "**/types.ts", "**/*.d.ts"],
      thresholds: {
        branches: 75,
        lines: 90,
        functions: 100,
        statements: 90,
      },
    },
  },
});
