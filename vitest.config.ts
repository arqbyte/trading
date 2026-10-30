import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Database tests share one database and reset it, so run files serially.
    fileParallelism: false,
  },
});
