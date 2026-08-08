/**
 * 프로젝트 전역 상수
 */

// GitHub API 관련
export const GITHUB_USER_AGENT = "DaleStudy-GitHub-App";
export const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";

// Webhook URL (Custom Domain)
export const WEBHOOK_URL = "https://github.dalestudy.com/webhooks";

// Organization/Repository
export const ALLOWED_ORG = "DaleStudy";
export const ALLOWED_REPO = "leetcode-study";

// 라벨
export const MAINTENANCE_LABEL = "maintenance";

// AI Gateway 를 거치는 OpenAI 엔드포인트.
// OpenAI 키는 게이트웨이에 저장돼 있어 요청에 싣지 않는다. 키를 실으면
// 게이트웨이가 저장된 키를 끼워 넣지 않고 그대로 전달한다.
const AI_GATEWAY_ACCOUNT_ID = "86aa227176a624680f7d34e691472576";
const AI_GATEWAY_ID = "dalestudy";
export const OPENAI_CHAT_COMPLETIONS_URL = `https://gateway.ai.cloudflare.com/v1/${AI_GATEWAY_ACCOUNT_ID}/${AI_GATEWAY_ID}/openai/chat/completions`;

// 게이트웨이에 재시도를 맡긴다. Worker 안에서 재시도하면 CPU 예산을 깎지만,
// 엣지에서 재시도하면 응답을 기다리는 시간일 뿐이다.
export const AI_GATEWAY_RETRY_HEADERS = {
  "cf-aig-max-attempts": "3",
  "cf-aig-retry-delay": "1000",
  "cf-aig-backoff": "exponential",
};
