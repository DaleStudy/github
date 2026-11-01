/**
 * 내부 디스패치 핸들러
 *
 * self-fetch를 통해 호출되는 내부 엔드포인트.
 * 웹훅 invocation 과 분리된 별도 Worker 호출(invocation)에서 실행되므로
 * 독립적인 subrequest 예산(50)을 갖는다.
 */

import { generateGitHubAppToken } from "../utils/github.js";
import { errorResponse, corsResponse } from "../utils/cors.js";
import { aiReview } from "./ai-review.js";

const INTERNAL_HEADER = "X-Internal-Secret";

/**
 * 내부 요청 인증 검증
 */
function verifyInternalRequest(request, env) {
  if (!env.INTERNAL_SECRET) {
    console.error("[internal-dispatch] INTERNAL_SECRET not configured");
    return false;
  }
  return request.headers.get(INTERNAL_HEADER) === env.INTERNAL_SECRET;
}

/**
 * 내부 디스패치 엔드포인트 라우터
 *
 * @param {Request} request
 * @param {object} env
 * @param {string} pathname
 */
export async function handleInternalDispatch(request, env, pathname) {
  if (!verifyInternalRequest(request, env)) {
    return errorResponse("Unauthorized", 401);
  }

  const payload = await request.json();

  try {
    const appToken = await generateGitHubAppToken(env);

    switch (pathname) {
      case "/internal/ai-review":
        return await handleAiReview(payload, appToken, env);

      default:
        return errorResponse("Not found", 404);
    }
  } catch (error) {
    console.error(`[internal-dispatch] ${pathname} failed:`, error);
    return errorResponse(`Internal handler error: ${error.message}`, 500);
  }
}

async function handleAiReview(payload, appToken, env) {
  const { repoOwner, repoName, prNumber, headSha, prData } = payload;
  const result = await aiReview(
    repoOwner,
    repoName,
    prNumber,
    headSha,
    prData,
    appToken,
    env.AI
  );
  return corsResponse({ handler: "ai-review", result });
}
