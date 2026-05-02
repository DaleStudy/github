import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["handlers/**/*.test.js", "utils/**/*.test.js", "tests/**/*.test.js"],
    testTimeout: 10000,
  },
});
