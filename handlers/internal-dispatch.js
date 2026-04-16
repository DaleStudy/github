/**
 * 내부 디스패치 핸들러
 *
 * self-fetch를 통해 호출되는 내부 엔드포인트.
 * 각 핸들러가 별도 Worker 호출(invocation)에서 실행되므로
 * 독립적인 subrequest 예산(50)을 갖는다.
 */

import { generateGitHubAppToken } from "../utils/github.js";
import { errorResponse, corsResponse } from "../utils/cors.js";
import { tagPatterns } from "./tag-patterns.js";
import { postLearningStatus } from "./learning-status.js";
import { analyzeComplexity } from "./complexity-analysis.js";

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
      case "/internal/tag-patterns":
        return await handleTagPatterns(payload, appToken, env);

      case "/internal/learning-status":
        return await handleLearningStatus(payload, appToken, env);

      case "/internal/complexity-analysis":
        return await handleComplexityAnalysis(payload, appToken, env);

      default:
        return errorResponse("Not found", 404);
    }
  } catch (error) {
    console.error(`[internal-dispatch] ${pathname} failed:`, error);
    return errorResponse(`Internal handler error: ${error.message}`, 500);
  }
}

async function handleTagPatterns(payload, appToken, env) {
  const { repoOwner, repoName, prNumber, headSha, prData } = payload;
  const result = await tagPatterns(
    repoOwner,
    repoName,
    prNumber,
    headSha,
    prData,
    appToken,
    env.OPENAI_API_KEY
  );
  return corsResponse({ handler: "tag-patterns", result });
}

async function handleLearningStatus(payload, appToken, env) {
  const { repoOwner, repoName, prNumber, username } = payload;
  const result = await postLearningStatus(
    repoOwner,
    repoName,
    prNumber,
    username,
    appToken,
    env.OPENAI_API_KEY
  );
  return corsResponse({ handler: "learning-status", result });
}

async function handleComplexityAnalysis(payload, appToken, env) {
  const { repoOwner, repoName, prNumber, prData } = payload;
  const result = await analyzeComplexity(
    repoOwner,
    repoName,
    prNumber,
    prData,
    appToken,
    env.OPENAI_API_KEY
  );
  return corsResponse({ handler: "complexity-analysis", result });
}
