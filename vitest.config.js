import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // AI 바인딩은 원격 전용이라 켜 두면 로그인 없는 CI 에서 풀이 시작하지 못한다.
      // 테스트는 tests/fakeAi.js 로 바인딩을 대신한다.
      remoteBindings: false,
    }),
  ],
  test: {
    include: ["handlers/**/*.test.js", "utils/**/*.test.js", "tests/**/*.test.js"],
    testTimeout: 10000,
  },
});
