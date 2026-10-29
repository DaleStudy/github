import { vi } from "vitest";

export const FAKE_AI_GATEWAY_URL =
  "https://gateway.test/openai/chat/completions";

/**
 * env.AI 바인딩 대역.
 *
 * gateway().run() 요청을 globalThis.fetch 로 넘긴다. OpenAI 응답은 fetch 모킹으로
 * 흉내 내고, subrequest 예산 테스트의 호출 수에도 그대로 포함된다.
 */
export function createFakeAi() {
  const run = vi.fn((request) =>
    fetch(FAKE_AI_GATEWAY_URL, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.query),
    })
  );
  return { gateway: vi.fn(() => ({ run })), run };
}
