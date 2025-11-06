/**
 * 리트코드 스터디 자동화 핸들러
 */

import { generateGitHubAppToken } from "../utils/github.js";
import { corsResponse, errorResponse } from "../utils/cors.js";
import {
  getWeekValue,
  ensureWarningComment,
  removeWarningComment,
} from "../utils/prWeeks.js";

/**
 * 모든 Open PR의 Week 설정을 검사하고 자동으로 댓글 작성/삭제
 *
 * @param {Request} request - Cloudflare Worker request
 * @param {Object} env - Environment variables
 * @returns {Response} CORS가 포함된 JSON 응답
 */
export async function checkWeeks(request, env) {
  try {
    const { repo_owner, repo_name } = await request.json();

    // Validation
    if (!repo_owner || !repo_name) {
      return errorResponse(
        "Missing required fields: repo_owner, repo_name",
        400
      );
    }

    // DaleStudy organization만 허용
    if (repo_owner !== "DaleStudy") {
      return errorResponse("Unauthorized organization", 403);
    }

    // GitHub App Token 생성
    const appToken = await generateGitHubAppToken(env);

    // Open PR 목록 조회
    const prsResponse = await fetch(
      `https://api.github.com/repos/${repo_owner}/${repo_name}/pulls?state=open&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${appToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "DaleStudy-GitHub-App",
        },
      }
    );

    const prs = await prsResponse.json();
    console.log(`Found ${prs.length} open PRs`);

    let checkedCount = 0;
    let commentedCount = 0;
    let deletedCount = 0;
    const results = [];

    // 각 PR 검사
    for (const pr of prs) {
      const prNumber = pr.number;
      const labels = pr.labels.map((l) => l.name);

      // maintenance 라벨이 있으면 스킵
      if (labels.includes("maintenance")) {
        console.log(`Skipping PR #${prNumber}: has maintenance label`);
        continue;
      }

      checkedCount++;

      // Week 설정 확인
      const weekValue = await getWeekValue(
        repo_owner,
        repo_name,
        prNumber,
        appToken
      );

      // Week 없으면 댓글 작성
      if (!weekValue) {
        const commented = await ensureWarningComment(
          repo_owner,
          repo_name,
          prNumber,
          env
        );

        if (commented) {
          commentedCount++;
        }

        results.push({ pr: prNumber, week: null, commented });
      } else {
        // Week 있으면 경고 댓글 삭제
        const deleted = await removeWarningComment(
          repo_owner,
          repo_name,
          prNumber,
          env
        );

        if (deleted) {
          deletedCount++;
        }

        results.push({ pr: prNumber, week: weekValue, commented: false, deleted });
        console.log(`PR #${prNumber}: Week ${weekValue}`);
      }
    }

    return corsResponse({
      success: true,
      total_prs: prs.length,
      checked: checkedCount,
      commented: commentedCount,
      deleted: deletedCount,
      results: results,
    });
  } catch (error) {
    console.error("Worker error:", error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
}
