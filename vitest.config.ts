import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.codex/**",
      "**/*.integration.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/lib/**/*.ts",
        "src/server/analysis/**/*.ts",
        "src/server/ai/**/*.ts",
        "src/server/api/routers/**/*.ts",
        "src/server/providers/**/*.ts",
        "src/server/security/**/*.ts",
        "src/server/sync/**/*.ts",
        "src/server/workspaces/**/*.ts",
        "src/validators/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/types.ts", "**/*.d.ts"],
      thresholds: {
        branches: 20,
        functions: 25,
        lines: 30,
        statements: 30,
      },
    },
  },
});
