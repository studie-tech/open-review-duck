import { defineConfig } from "@flue/cli/config";

export default defineConfig({
  target: "node",
  output: "./dist/flue",
});

export const vite = {
  server: {
    watch: {
      ignored: ["**/.next/**"],
    },
  },
};
