import { generateGitHubAppToken, getGitHubHeaders } from "../utils/github.js";
import { corsResponse, errorResponse } from "../utils/cors.js";
import {
  parsePrActionPayload,
  fetchOpenPullRequests,
  filterTargetPrs,
  getSkipReason,
  formatResult,
  safeJson,
  hasApprovedReview,
} from "../utils/prActions.js";

const APPROVAL_COMMENT = `현재 주차가 종료되어 자동으로 승인되었습니다. PR을 병합해주세요!`;

/**
 * Bulk approve handler
 *
 * @param {Request} request - Worker request object
 * @param {Env} env - Worker bindings (APP_ID, PRIVATE_KEY, etc.)
 */
export async function approvePrs(request, env) {
  try {
    const payload = await parsePrActionPayload(request);
    if (!payload.valid) {
      return payload.response;
    }

    const { repoOwner, repoName, excludes } = payload.data;
    const appToken = await generateGitHubAppToken(env);
    const openPrs = await fetchOpenPullRequests(repoOwner, repoName, appToken);
    const targetPrs = filterTargetPrs(openPrs, excludes);

    const results = [];
    let approved = 0;
    let skipped = 0;

    for (const pr of targetPrs) {
      const skipReason = getSkipReason(pr);
      if (skipReason) {
        skipped++;
        results.push(formatResult(pr, { skipped: true, reason: skipReason }));
        continue;
      }

      const alreadyApproved = await hasApprovedReview(
        repoOwner,
        repoName,
        pr.number,
        appToken
      );
      if (alreadyApproved) {
        skipped++;
        results.push(
          formatResult(pr, { skipped: true, reason: "already approved" })
        );
        continue;
      }

      const reviewResult = await approvePullRequest(
        repoOwner,
        repoName,
        pr.number,
        appToken
      );

      if (reviewResult.approved) {
        approved++;
      }

      results.push(formatResult(pr, reviewResult));
    }

    return corsResponse({
      success: true,
      action: "approve",
      repo: `${repoOwner}/${repoName}`,
      total_open_prs: openPrs.length,
      processed: targetPrs.length,
      approved,
      skipped,
      results,
    });
  } catch (error) {
    console.error("approvePrs error:", error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
}

async function approvePullRequest(owner, repo, prNumber, token) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: {
        ...getGitHubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: APPROVAL_COMMENT,
        event: "APPROVE",
      }),
    }
  );

  const payload = await safeJson(response);

  if (response.ok) {
    return { approved: true };
  }

  return {
    approved: false,
    error: payload.message || "Approval failed",
  };
}
