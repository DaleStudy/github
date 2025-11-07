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
export async function getPRDiff(repoOwner, repoName, prNumber, githubToken) {
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
  await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: getGitHubHeaders(githubToken),
      body: JSON.stringify({ body: reviewContent }),
    }
  );
}

/**
 * 스레드 답변으로 AI 코드 리뷰 작성
 *
 * @param {string} repoOwner - 저장소 소유자
 * @param {string} repoName - 저장소 이름
 * @param {number} prNumber - PR 번호
 * @param {number} commentId - 원본 댓글 ID
 * @param {string} reviewContent - 리뷰 내용 (마크다운)
 * @param {string} githubToken - GitHub 토큰
 */
async function postThreadReply(
  repoOwner,
  repoName,
  prNumber,
  commentId,
  reviewContent,
  githubToken
) {
  await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments/${commentId}/replies`,
    {
      method: "POST",
      headers: getGitHubHeaders(githubToken),
      body: JSON.stringify({ body: reviewContent }),
    }
  );
}

/**
 * 댓글에 reaction 추가
 *
 * @param {string} repoOwner - 저장소 소유자
 * @param {string} repoName - 저장소 이름
 * @param {number} commentId - 댓글 ID
 * @param {string} commentType - 댓글 타입 ('issue' 또는 'pull')
 * @param {string} reaction - reaction 타입 (예: 'eyes')
 * @param {string} githubToken - GitHub 토큰
 */
export async function addReactionToComment(
  repoOwner,
  repoName,
  commentId,
  commentType,
  reaction,
  githubToken
) {
  const endpoint = commentType === "issue"
    ? `https://api.github.com/repos/${repoOwner}/${repoName}/issues/comments/${commentId}/reactions`
    : `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/comments/${commentId}/reactions`;

  await fetch(endpoint, {
    method: "POST",
    headers: getGitHubHeaders(githubToken),
    body: JSON.stringify({ content: reaction }),
  });
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
 * @param {string} userRequest - 사용자의 구체적인 요청 (선택사항)
 * @param {number} replyToCommentId - 스레드 답변으로 작성할 댓글 ID (선택사항)
 */
export async function performAIReview(
  repoOwner,
  repoName,
  prNumber,
  prTitle,
  prBody,
  githubToken,
  openaiApiKey,
  userRequest = null,
  replyToCommentId = null
) {
  console.log(`Starting AI review for PR #${prNumber}${userRequest ? ` - Request: ${userRequest}` : ""}`);

  // PR diff 가져오기
  const prDiff = await getPRDiff(repoOwner, repoName, prNumber, githubToken);

  // diff가 너무 크면 스킵 (토큰 비용 절약)
  const diffLines = prDiff.split("\n").length;
  if (diffLines > 1000) {
    console.log(`Skipping AI review: diff too large (${diffLines} lines)`);
    return;
  }

  // AI 리뷰 생성 (userRequest 전달)
  const reviewContent = await generateCodeReview(
    prDiff,
    prTitle,
    prBody,
    openaiApiKey,
    userRequest
  );

  // 리뷰 댓글 작성 (스레드 답변 또는 일반 댓글)
  if (replyToCommentId) {
    await postThreadReply(
      repoOwner,
      repoName,
      prNumber,
      replyToCommentId,
      reviewContent,
      githubToken
    );
    console.log(`AI review posted as thread reply for PR #${prNumber}`);
  } else {
    await postReviewComment(
      repoOwner,
      repoName,
      prNumber,
      reviewContent,
      githubToken
    );
    console.log(`AI review posted for PR #${prNumber}`);
  }
}
