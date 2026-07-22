import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: [
        "src/server/ai/**/*.ts",
        "src/server/api/routers/**/*.ts",
        "src/server/review/**/*.ts",
        "src/server/security/**/*.ts",
        "src/server/sync/**/*.ts",
        "src/server/workspaces/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/types.ts", "**/*.d.ts"],
      thresholds: {
        branches: 10,
        lines: 15,
        functions: 15,
        statements: 15,
      },
    },
  },
});
