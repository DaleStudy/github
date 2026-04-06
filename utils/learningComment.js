/**
 * Learning status comment formatting and upsert utilities
 */

import { getGitHubHeaders } from "./github.js";

/**
 * Marker that identifies a learning status comment posted by this app.
 */
const COMMENT_MARKER = "<!-- dalestudy-learning-status -->";

/**
 * Returns true when `comment` is a Bot comment containing our marker.
 *
 * @param {{ user?: { type?: string }, body?: string }} comment
 * @returns {boolean}
 */
function isLearningStatusComment(comment) {
  return comment.user?.type === "Bot" && comment.body?.includes(COMMENT_MARKER);
}

/**
 * Renders a simple block-character progress bar.
 *
 * @param {number} completed
 * @param {number} total
 * @param {number} [barLength=7]
 * @returns {string}  e.g. "■■■□□□□"
 */
function progressBar(completed, total, barLength = 7) {
  if (total === 0) {
    return "□".repeat(barLength);
  }
  const filled = Math.min(Math.round((completed / total) * barLength), barLength);
  return "■".repeat(filled) + "□".repeat(barLength - filled);
}

/**
 * Formats a learning status Markdown comment.
 *
 * @param {string} username
 * @param {Array<{ problemName: string, difficulty: string|null, matches: boolean|null, explanation: string }>} submissions
 * @param {number} totalSolved
 * @param {number} totalProblems
 * @param {Array<{ category: string, solved: number, total: number, difficulties: string }>} categoryProgress
 * @returns {string}
 */
export function formatLearningStatusComment(
  username,
  submissions,
  totalSolved,
  totalProblems,
  categoryProgress
) {
  const lines = [];

  lines.push(COMMENT_MARKER);
  lines.push(`## 📊 ${username} 님의 학습 현황`);
  lines.push("");

  // --- Submission table ---
  lines.push("### 이번 주 제출 문제");
  lines.push("| 문제 | 난이도 | 유형 분석 |");
  lines.push("|---|---|---|");

  for (const { problemName, difficulty, matches } of submissions) {
    const difficultyCell = difficulty ?? "-";

    let analysisCell;
    if (matches === null) {
      analysisCell = "ℹ️ 카테고리 정보 없음";
    } else if (matches === true) {
      analysisCell = "✅ 의도한 유형";
    } else {
      analysisCell = "⚠️ 유형 불일치";
    }

    lines.push(`| ${problemName} | ${difficultyCell} | ${analysisCell} |`);
  }

  lines.push("");

  // --- Cumulative summary ---
  lines.push("### 누적 학습 요약");
  lines.push(`- 풀이한 문제: ${totalSolved} / ${totalProblems}개`);

  // Match rate line — only include when at least one submission has matches !== null
  const gradedSubmissions = submissions.filter((s) => s.matches !== null);
  if (gradedSubmissions.length > 0) {
    const matched = gradedSubmissions.filter((s) => s.matches === true).length;
    const total = gradedSubmissions.length;
    const rate = Math.round((matched / total) * 100);
    lines.push(
      `- 이번 주 유형 일치율: ${rate}% (${total}문제 중 ${matched}문제 일치)`
    );
  }

  lines.push("");

  // --- Category progress ---
  if (categoryProgress.length > 0) {
    lines.push("### 문제 풀이 현황");
    lines.push("| 카테고리 | 진행도 | 완료 |");
    lines.push("|---|---|---|");

    for (const { category, solved, total, difficulties } of categoryProgress) {
      const bar = progressBar(solved, total);
      let completionCell = difficulties
        ? `${solved} / ${total} (${difficulties})`
        : `${solved} / ${total}`;
      if (solved === 0) {
        completionCell += " ← 아직 시작 안 함";
      }
      lines.push(`| ${category} | ${bar} | ${completionCell} |`);
    }

    lines.push("");
  }

  lines.push("---");
  lines.push("🤖 이 댓글은 GitHub App을 통해 자동으로 작성되었습니다.");

  return lines.join("\n") + "\n";
}

/**
 * Creates or updates the learning status comment on a PR.
 *
 * Searches through the first 100 issue comments for an existing Bot comment
 * that contains COMMENT_MARKER. If found, PATCHes it; otherwise POSTs a new one.
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} commentBody
 * @param {string} appToken
 * @returns {Promise<void>}
 */
export async function upsertLearningStatusComment(
  repoOwner,
  repoName,
  prNumber,
  commentBody,
  appToken
) {
  const baseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}`;

  // Fetch existing comments
  const listResponse = await fetch(
    `${baseUrl}/issues/${prNumber}/comments?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!listResponse.ok) {
    throw new Error(
      `[learningStatus] Failed to list comments on PR #${prNumber}: ${listResponse.status} ${listResponse.statusText}`
    );
  }

  const comments = await listResponse.json();
  const existing = comments.find(isLearningStatusComment);

  if (existing) {
    // Update existing comment
    console.log(
      `[learningStatus] Updating existing comment ${existing.id} on PR #${prNumber}`
    );

    const patchResponse = await fetch(
      `${baseUrl}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        headers: {
          ...getGitHubHeaders(appToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: commentBody }),
      }
    );

    if (!patchResponse.ok) {
      const errorData = await patchResponse.json();
      throw new Error(
        `[learningStatus] Failed to update comment ${existing.id} on PR #${prNumber}: ${JSON.stringify(errorData)}`
      );
    }

    console.log(
      `[learningStatus] Updated comment ${existing.id} on PR #${prNumber}`
    );
  } else {
    // Post new comment
    console.log(
      `[learningStatus] Posting new learning status comment on PR #${prNumber}`
    );

    const postResponse = await fetch(
      `${baseUrl}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: {
          ...getGitHubHeaders(appToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: commentBody }),
      }
    );

    if (!postResponse.ok) {
      const errorData = await postResponse.json();
      throw new Error(
        `[learningStatus] Failed to post comment on PR #${prNumber}: ${JSON.stringify(errorData)}`
      );
    }

    console.log(
      `[learningStatus] Created new comment on PR #${prNumber}`
    );
  }
}
