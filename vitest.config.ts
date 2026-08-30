import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Unit tests must never touch a real browser or the Anthropic API.
    // Anything that needs Playwright or an API key lives in src/cli/* and
    // is exercised manually via the discover/replay scripts, not here.
    testTimeout: 10_000
  }
});
