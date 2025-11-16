import { generateGitHubAppToken, getGitHubHeaders } from "../utils/github.js";
import { corsResponse, errorResponse } from "../utils/cors.js";
import {
  parsePrActionPayload,
  fetchOpenPullRequests,
  filterTargetPrs,
  filterByWeekAndStatus,
  getSkipReason,
  formatResult,
  safeJson,
  hasApprovedReview,
} from "../utils/prActions.js";
import { getPullRequestDetails } from "../utils/pullRequests.js";

const ALLOWED_MERGE_METHODS = new Set(["merge", "squash", "rebase"]);

/**
 * Bulk merge handler
 *
 * @param {Request} request - Worker request object
 * @param {Env} env - Worker bindings (APP_ID, PRIVATE_KEY, etc.)
 */
export async function mergePrs(request, env) {
  try {
    const payload = await parsePrActionPayload(request);
    if (!payload.valid) {
      return payload.response;
    }

    const { repoOwner, repoName, week, excludes, rawPayload } = payload.data;
    const mergeMethod = (rawPayload.merge_method || "merge").toLowerCase();

    if (!ALLOWED_MERGE_METHODS.has(mergeMethod)) {
      return errorResponse(
        `Invalid merge_method. Allowed values: ${[
          ...ALLOWED_MERGE_METHODS,
        ].join(", ")}`,
        400
      );
    }

    const appToken = await generateGitHubAppToken(env);
    const openPrs = await fetchOpenPullRequests(repoOwner, repoName, appToken);

    // Week와 Status 필터링
    const { filtered: weekFilteredPrs, weekMismatched, solvingExcluded } =
      await filterByWeekAndStatus(openPrs, week, repoOwner, repoName, appToken);

    const targetPrs = filterTargetPrs(weekFilteredPrs, excludes);

    const results = [];
    let merged = 0;
    let skipped = 0;

    for (const pr of targetPrs) {
      const skipReason = getSkipReason(pr);
      if (skipReason) {
        skipped++;
        results.push(formatResult(pr, { skipped: true, reason: skipReason }));
        continue;
      }

      const approved = await hasApprovedReview(
        repoOwner,
        repoName,
        pr.number,
        appToken
      );

      if (!approved) {
        skipped++;
        results.push(
          formatResult(pr, {
            skipped: true,
            reason: "no approvals",
          })
        );
        continue;
      }

      let mergeableState = await getMergeableState(
        repoOwner,
        repoName,
        pr.number,
        appToken
      );

      // 최대 3번 재시도 (총 4번 조회, 최대 6초 대기)
      let retries = 0;
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 2000; // 2초

      while (!mergeableState.mergeable && mergeableState.retryable && retries < MAX_RETRIES) {
        await delay(RETRY_DELAY);
        mergeableState = await getMergeableState(
          repoOwner,
          repoName,
          pr.number,
          appToken
        );
        retries++;
      }

      if (!mergeableState.mergeable) {
        skipped++;
        results.push(
          formatResult(pr, {
            skipped: true,
            reason: mergeableState.reason,
          })
        );
        continue;
      }

      const mergeResult = await mergePullRequest(
        repoOwner,
        repoName,
        pr.number,
        mergeMethod,
        appToken,
        mergeableState.sha
      );

      if (mergeResult.merged) {
        merged++;
      }

      results.push(formatResult(pr, mergeResult));
    }

    return corsResponse({
      success: true,
      action: "merge",
      repo: `${repoOwner}/${repoName}`,
      week_filter: week,
      total_open_prs: openPrs.length,
      week_matched: weekFilteredPrs.length,
      week_mismatched: weekMismatched,
      solving_excluded: solvingExcluded,
      processed: targetPrs.length,
      merged,
      skipped,
      merge_method: mergeMethod,
      results,
    });
  } catch (error) {
    console.error("mergePrs error:", error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
}

async function mergePullRequest(owner, repo, prNumber, mergeMethod, token, sha) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      headers: {
        ...getGitHubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        merge_method: mergeMethod,
        sha,
      }),
    }
  );

  const payload = await safeJson(response);
  if (response.ok && payload?.merged) {
    return { merged: true, sha: payload.sha };
  }

  return {
    merged: false,
    error: payload?.message || "Merge failed",
  };
}

async function getMergeableState(owner, repo, prNumber, token) {
  const prDetails = await getPullRequestDetails(owner, repo, prNumber, token);

  if (!prDetails.mergeable) {
    if (prDetails.mergeable === null) {
      return {
        mergeable: false,
        reason: "mergeability unknown",
        retryable: true,
      };
    }

    return {
      mergeable: false,
      reason: "not mergeable",
      retryable: false,
    };
  }

  const mergeableState = prDetails.mergeable_state || "unknown";
  if (mergeableState !== "clean") {
    return {
      mergeable: false,
      reason: mergeableState,
      retryable: mergeableState === "unknown" || mergeableState === "behind",
    };
  }

  return {
    mergeable: true,
    sha: prDetails.head.sha,
    retryable: false,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
