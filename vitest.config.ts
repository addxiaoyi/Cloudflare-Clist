import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "app/lib/quark-login.ts",
        "app/lib/client-factory.ts",
        "app/lib/github-client.ts",
      ],
      exclude: [
        "app/lib/git/**",
      ],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 30,
        statements: 40,
      },
    },
  },
});
