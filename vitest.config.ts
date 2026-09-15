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
      reporter: ["text", "json", "json-summary", "html", "lcov"],
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
        lines: 35,
        functions: 35,
        branches: 25,
        statements: 35,
        perFile: true,
      },
    },
  },
});
