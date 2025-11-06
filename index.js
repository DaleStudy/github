/**
 * Cloudflare Worker: DaleStudy GitHub App
 *
 * DaleStudy 조직의 자동화 작업을 처리하는 통합 GitHub App
 */

import { checkWeeks } from "./handlers/check-weeks.js";
import { preflightResponse, corsResponse } from "./utils/cors.js";

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return preflightResponse();
    }

    if (request.method !== "POST") {
      return corsResponse({ error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);

    // PR Week 설정 검사
    if (url.pathname === "/check-weeks") {
      return checkWeeks(request, env);
    }

    // 지원하지 않는 엔드포인트
    return corsResponse({ error: "Not found" }, 404);
  },
};
