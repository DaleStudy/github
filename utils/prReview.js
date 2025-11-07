/**
 * PR 자동 리뷰 유틸리티
 */

import { getGitHubHeaders } from "./github.js";
import { generateCodeReview } from "./openai.js";

/**
 * PR diff 가져오기
 *
 * @param {string} repoOwner - 저장소 소유자
 * @param {string} repoName - 저장소 이름
 * @param {number} prNumber - PR 번호
 * @param {string} githubToken - GitHub 토큰
 * @returns {Promise<string>} PR diff 내용
 */
async function getPRDiff(repoOwner, repoName, prNumber, githubToken) {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
    {
      headers: {
        ...getGitHubHeaders(githubToken),
        Accept: "application/vnd.github.v3.diff",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get PR diff: ${response.statusText}`);
  }

  return await response.text();
}

/**
 * AI 코드 리뷰 댓글 작성
 *
 * @param {string} repoOwner - 저장소 소유자
 * @param {string} repoName - 저장소 이름
 * @param {number} prNumber - PR 번호
 * @param {string} reviewContent - 리뷰 내용 (마크다운)
 * @param {string} githubToken - GitHub 토큰
 */
async function postReviewComment(
  repoOwner,
  repoName,
  prNumber,
  reviewContent,
  githubToken
) {
  const commentBody = `## 🤖 AI Code Review

${reviewContent}`;

  await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: getGitHubHeaders(githubToken),
      body: JSON.stringify({ body: commentBody }),
    }
  );
}

/**
 * PR에 대해 AI 리뷰 수행
 *
 * @param {string} repoOwner - 저장소 소유자
 * @param {string} repoName - 저장소 이름
 * @param {number} prNumber - PR 번호
 * @param {string} prTitle - PR 제목
 * @param {string} prBody - PR 본문
 * @param {string} githubToken - GitHub 토큰
 * @param {string} openaiApiKey - OpenAI API 키
 */
export async function performAIReview(
  repoOwner,
  repoName,
  prNumber,
  prTitle,
  prBody,
  githubToken,
  openaiApiKey
) {
  console.log(`Starting AI review for PR #${prNumber}`);

  // PR diff 가져오기
  const prDiff = await getPRDiff(repoOwner, repoName, prNumber, githubToken);

  // diff가 너무 크면 스킵 (토큰 비용 절약)
  const diffLines = prDiff.split("\n").length;
  if (diffLines > 1000) {
    console.log(`Skipping AI review: diff too large (${diffLines} lines)`);
    return;
  }

  // AI 리뷰 생성
  const reviewContent = await generateCodeReview(
    prDiff,
    prTitle,
    prBody,
    openaiApiKey
  );

  // 리뷰 댓글 작성
  await postReviewComment(
    repoOwner,
    repoName,
    prNumber,
    reviewContent,
    githubToken
  );

  console.log(`AI review posted for PR #${prNumber}`);
}
