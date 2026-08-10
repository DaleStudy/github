/**
 * 특정 날짜가 속한 기수/주차 조회 핸들러
 *
 * Actions의 기본 GITHUB_TOKEN으로는 org 프로젝트 보드를 읽을 수 없어
 * (read:project 스코프 부재), 주차 조회를 App 토큰을 가진 워커가 대신한다.
 */

import { generateGitHubAppToken } from "../utils/github.js";
import { corsResponse, errorResponse } from "../utils/cors.js";
import { resolveIteration } from "../utils/iterations.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {Request} request - Worker request object
 * @param {Env} env - Worker bindings (APP_ID, PRIVATE_KEY, etc.)
 */
export async function resolveIterationHandler(request, env) {
  try {
    const { date } = await request.json().catch(() => ({}));

    if (!date) {
      return errorResponse("Missing required field: date (YYYY-MM-DD)", 400);
    }

    if (!DATE_PATTERN.test(date)) {
      return errorResponse(`Invalid date format: ${date} (expected YYYY-MM-DD)`, 400);
    }

    const appToken = await generateGitHubAppToken(env);
    const iteration = await resolveIteration(appToken, date);

    if (!iteration) {
      return corsResponse({ success: true, date, found: false });
    }

    return corsResponse({
      success: true,
      date,
      found: true,
      cohort: iteration.cohort,
      week: iteration.week,
      week_label: iteration.weekLabel,
      project_number: iteration.projectNumber,
      project_title: iteration.projectTitle,
      start_date: iteration.startDate,
      end_date: iteration.endDate,
    });
  } catch (error) {
    console.error("resolveIteration error:", error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
}
