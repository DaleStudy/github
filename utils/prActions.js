/**
 * Shared helpers for PR bulk actions
 */

import { errorResponse } from "./cors.js";
import { getGitHubHeaders } from "./github.js";
import { validateOrganization, hasMaintenanceLabel } from "./validation.js";

/**
 * 공통 payload 파서
 */
export async function parsePrActionPayload(request) {
  try {
    const data = await request.json();
    const repoOwner = data.repo_owner || "DaleStudy";
    const repoName = data.repo_name;

    if (!repoName) {
      return {
        valid: false,
        response: errorResponse(
          "Missing required field: repo_name",
          400
        ),
      };
    }

    if (!validateOrganization(repoOwner)) {
      return {
        valid: false,
        response: errorResponse(`Unauthorized organization: ${repoOwner}`, 403),
      };
    }

    const excludes = parseNumberArray(data.excludes);

    return {
      valid: true,
      data: {
        repoOwner,
        repoName,
        excludes,
        rawPayload: data,
      },
    };
  } catch (error) {
    console.error("Failed to parse payload:", error);
    return {
      valid: false,
      response: errorResponse("Invalid JSON payload", 400),
    };
  }
}

/**
 * Open PR 목록 조회
 */
export async function fetchOpenPullRequests(owner, repo, token) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
    {
      headers: getGitHubHeaders(token),
    }
  );

  if (!response.ok) {
    const errorData = await safeJson(response);
    throw new Error(
      `Failed to fetch open PRs: ${response.status} ${
        errorData.message || response.statusText
      }`
    );
  }

  return await response.json();
}

/**
 * 대상 PR 필터링
 */
export function filterTargetPrs(pullRequests, excludes) {
  if (!excludes || excludes.length === 0) {
    return pullRequests;
  }

  const excludeSet = new Set(excludes);
  return pullRequests.filter((pr) => !excludeSet.has(pr.number));
}

/**
 * 공통 skip 조건
 */
export function getSkipReason(pr) {
  const labels = (pr.labels || []).map((label) => label.name);
  if (hasMaintenanceLabel(labels)) {
    return "maintenance labeled";
  }

  if (pr.draft) {
    return "draft PR";
  }

  return null;
}

/**
 * 결과 포매터
 */
export function formatResult(pr, result) {
  return {
    pr: pr.number,
    title: pr.title,
    ...result,
  };
}

/**
 * 안전한 JSON 파싱
 */
export async function safeJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

/**
 * PR이 승인되었는지 확인
 */
export async function hasApprovedReview(owner, repo, prNumber, token) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      headers: getGitHubHeaders(token),
    }
  );

  if (!response.ok) {
    const errorData = await safeJson(response);
    throw new Error(
      `Failed to fetch reviews for PR #${prNumber}: ${response.status} ${
        errorData.message || response.statusText
      }`
    );
  }

  const reviews = await response.json();
  return reviews.some((review) => review.state === "APPROVED");
}

function parseNumberArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  return [...new Set(value)]
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n));
}
