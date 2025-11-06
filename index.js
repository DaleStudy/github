/**
 * Cloudflare Worker: DaleStudy GitHub App
 *
 * DaleStudy 조직의 자동화 작업을 처리하는 통합 GitHub App
 */

import { checkWeeks } from "./handlers/check-weeks.js";
import { handleWebhook } from "./handlers/webhooks.js";
import { preflightResponse, corsResponse, errorResponse } from "./utils/cors.js";
import { verifyWebhookSignature } from "./utils/webhook.js";

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

    // GitHub Webhook 수신
    if (url.pathname === "/webhooks") {
      // Webhook signature 검증
      const signature = request.headers.get("X-Hub-Signature-256");
      const rawBody = await request.text();

      // Secret이 설정되어 있으면 검증
      if (env.WEBHOOK_SECRET) {
        const isValid = await verifyWebhookSignature(
          rawBody,
          signature,
          env.WEBHOOK_SECRET
        );

        if (!isValid) {
          console.error("Invalid webhook signature");
          return errorResponse("Invalid signature", 401);
        }
      }

      // Request 객체 재생성 (body를 다시 읽을 수 있도록)
      const newRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: rawBody,
      });

      return handleWebhook(newRequest, env);
    }

    // PR Week 설정 검사 (수동 호출용)
    if (url.pathname === "/check-weeks") {
      return checkWeeks(request, env);
    }

    // 지원하지 않는 엔드포인트
    return corsResponse({ error: "Not found" }, 404);
  },
};
