/**
 * GitHub Webhook 이벤트 핸들러
 */

import {
  generateGitHubAppToken,
  getGitHubHeaders,
  getPRInfoFromNodeId,
} from "../utils/github.js";
import { corsResponse, errorResponse } from "../utils/cors.js";
import {
  ensureWarningComment,
  removeWarningComment,
  handleWeekComment,
} from "../utils/prWeeks.js";
import {
  validateOrganization,
  hasMaintenanceLabel,
  isClosedPR,
} from "../utils/validation.js";
import { ALLOWED_REPO } from "../utils/constants.js";
import { performAIReview, addReactionToComment } from "../utils/prReview.js";
import { hasApprovedReview, safeJson } from "../utils/prActions.js";
import { tagPatterns } from "./tag-patterns.js";
import { postLearningStatus } from "./learning-status.js";

/**
 * GitHub webhook 이벤트 처리
 */
export async function handleWebhook(request, env) {
  try {
    const payload = await request.json();
    const eventType = request.headers.get("X-GitHub-Event");

    console.log(`Received webhook event: ${eventType}`);

    // DaleStudy organization만 허용
    const orgLogin = payload.organization?.login;
    if (!validateOrganization(orgLogin)) {
      console.log(`Ignoring event from organization: ${orgLogin}`);
      return corsResponse({ message: "Ignored: not DaleStudy organization" });
    }

    // 특정 repository만 허용 (leetcode-study)
    const repoName = payload.repository?.name;
    if (repoName && repoName !== ALLOWED_REPO) {
      console.log(`Ignoring event from repository: ${repoName}`);
      return corsResponse({ message: `Ignored: ${repoName}` });
    }

    // 이벤트 타입별 처리
    switch (eventType) {
      case "projects_v2_item":
        return handleProjectsV2ItemEvent(payload, env);

      case "pull_request":
        return handlePullRequestEvent(payload, env);

      case "issue_comment":
        return handleIssueCommentEvent(payload, env);

      case "pull_request_review_comment":
        return handlePullRequestReviewCommentEvent(payload, env);

      default:
        console.log(`Unhandled event type: ${eventType}`);
        return corsResponse({ message: `Ignored: ${eventType}` });
    }
  } catch (error) {
    console.error("Webhook handler error:", error);
    return errorResponse(`Webhook error: ${error.message}`, 500);
  }
}

/**
 * Projects v2 item 이벤트 처리 (Week 설정 변경 감지)
 */
async function handleProjectsV2ItemEvent(payload, env) {
  const action = payload.action;

  // edited, created, deleted 액션만 처리
  if (!["edited", "created", "deleted"].includes(action)) {
    console.log(`Ignoring projects_v2_item action: ${action}`);
    return corsResponse({ message: `Ignored: ${action}` });
  }

  console.log(`Processing projects_v2_item action: ${action}`);

  // PR과 연결된 item인지 확인
  const contentType = payload.projects_v2_item?.content_type;
  if (contentType !== "PullRequest") {
    console.log(`Ignoring non-PR item: ${contentType}`);
    return corsResponse({ message: "Ignored: not a PR" });
  }

  // deleted 액션은 항상 처리 (프로젝트에서 제거 = Week 설정 불가능)
  // created 액션도 항상 처리 (프로젝트 추가 시 Week 누락 체크)
  if (action !== "deleted" && action !== "created") {
    // edited 액션은 Week 필드 변경인지 확인
    const changes = payload.changes;
    const isWeekField =
      changes?.field_value?.field_name === "Week" ||
      changes?.field_value?.from?.field_name === "Week";

    if (!isWeekField) {
      console.log("Ignoring: not a Week field change");
      return corsResponse({ message: "Ignored: not Week field" });
    }
  }

  // PR 정보 추출 (GraphQL로 content_node_id 조회)
  const contentNodeId = payload.projects_v2_item?.content_node_id;
  if (!contentNodeId) {
    console.log("No content_node_id found");
    return corsResponse({ message: "Ignored: no content_node_id" });
  }

  const appToken = await generateGitHubAppToken(env);
  const prInfo = await getPRInfoFromNodeId(contentNodeId, appToken);

  if (!prInfo) {
    console.log(`Failed to get PR info for node: ${contentNodeId}`);
    return errorResponse("Failed to get PR info", 500);
  }

  const { number: prNumber, owner: repoOwner, repo: repoName } = prInfo;

  // PR 상태 확인 (closed PR, maintenance 라벨 예외)
  const prResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (prResponse.ok) {
    const prData = await prResponse.json();

    // Closed PR 체크
    if (isClosedPR(prData.state)) {
      console.log(`Skipping closed PR #${prNumber}`);
      return corsResponse({ message: "Ignored: closed PR" });
    }

    // maintenance 라벨 체크
    const labels = prData.labels.map((l) => l.name);
    if (hasMaintenanceLabel(labels)) {
      console.log(`Skipping PR #${prNumber}: has maintenance label`);
      return corsResponse({ message: "Ignored: maintenance label" });
    }
  }

  // deleted 액션은 Week 설정 불가능하므로 경고 댓글 작성
  if (action === "deleted") {
    console.log(`Project removed from PR #${prNumber}`);
    await ensureWarningComment(repoOwner, repoName, prNumber, env);

    return corsResponse({
      message: "Processed",
      pr: prNumber,
      action: "deleted",
      week: null,
    });
  }

  // created 액션은 실제 Week 값을 조회해서 확인
  if (action === "created") {
    console.log(`PR #${prNumber} added to project`);

    const weekValue = await handleWeekComment(
      repoOwner,
      repoName,
      prNumber,
      env,
      appToken
    );

    console.log(`Week value after project add: ${weekValue || "not set"}`);

    return corsResponse({
      message: "Processed",
      pr: prNumber,
      action: "created",
      week: weekValue,
    });
  }

  // edited 액션은 payload의 changes에서 Week 값 확인
  const weekValue = payload.changes?.field_value?.to?.title || null;

  console.log(
    `Week ${action} for PR #${prNumber}: ${weekValue || "removed"}`
  );

  // Week 설정 여부에 따라 댓글 작성/삭제
  if (!weekValue) {
    await ensureWarningComment(repoOwner, repoName, prNumber, env);
  } else {
    await removeWarningComment(repoOwner, repoName, prNumber, env);
  }

  return corsResponse({
    message: "Processed",
    pr: prNumber,
    week: weekValue,
  });
}

/**
 * Compare API로 두 커밋 사이에 변경된 파일명 목록 조회
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {string} baseSha - 이전 커밋 SHA
 * @param {string} headSha - 새 커밋 SHA
 * @param {string} appToken
 * @returns {Promise<string[]|null>} 변경된 파일명 배열 (실패 시 null → 전체 분석 fallback)
 */
async function getChangedFilenames(repoOwner, repoName, baseSha, headSha, appToken) {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/compare/${baseSha}...${headSha}`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!response.ok) {
    console.error(`[getChangedFilenames] Compare API failed: ${response.status}`);
    return null;
  }

  const data = await response.json();
  return (data.files || []).map((f) => f.filename);
}

/**
 * Pull Request 이벤트 처리
 * - opened/reopened: Week 설정 체크 + 알고리즘 패턴 태깅 (전체 파일)
 * - synchronize: 알고리즘 패턴 태깅만 (변경된 파일만, Week 체크 스킵)
 */
async function handlePullRequestEvent(payload, env) {
  const action = payload.action;

  // opened, reopened, synchronize 액션만 처리
  if (!["opened", "reopened", "synchronize"].includes(action)) {
    console.log(`Ignoring pull_request action: ${action}`);
    return corsResponse({ message: `Ignored: ${action}` });
  }

  console.log(`Processing pull_request action: ${action}`);

  const pr = payload.pull_request;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const prNumber = pr.number;

  // maintenance 라벨 체크 (early exit - GitHub API 호출 전에)
  const labels = pr.labels.map((l) => l.name);
  if (hasMaintenanceLabel(labels)) {
    console.log(`Skipping PR #${prNumber}: has maintenance label`);
    return corsResponse({ message: "Ignored: maintenance label" });
  }

  const appToken = await generateGitHubAppToken(env);
  let weekValue = null;

  // Week 체크는 opened/reopened일 때만 (synchronize는 이미 설정됐을 가능성 높음)
  if (action === "opened" || action === "reopened") {
    console.log(`New PR ${action}: #${prNumber}`);

    // 잠시 대기 후 체크 (프로젝트 추가 시간 고려)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    weekValue = await handleWeekComment(
      repoOwner,
      repoName,
      prNumber,
      env,
      appToken
    );
  } else {
    console.log(`PR synchronized: #${prNumber}`);
  }

  // 알고리즘 패턴 태깅 (OPENAI_API_KEY 있을 때만)
  if (env.OPENAI_API_KEY) {
    try {
      // synchronize일 때만 변경 파일 목록 추출 (최적화: #7)
      let changedFilenames = null;
      if (action === "synchronize" && payload.before && payload.after) {
        changedFilenames = await getChangedFilenames(
          repoOwner,
          repoName,
          payload.before,
          payload.after,
          appToken
        );
        console.log(
          `[handlePullRequestEvent] synchronize: ${changedFilenames?.length ?? "fallback(all)"} files changed between ${payload.before.slice(0, 7)}...${payload.after.slice(0, 7)}`
        );
      }

      await tagPatterns(
        repoOwner,
        repoName,
        prNumber,
        pr.head.sha,
        pr,
        appToken,
        env.OPENAI_API_KEY,
        changedFilenames
      );
    } catch (error) {
      console.error(`[handlePullRequestEvent] tagPatterns failed: ${error.message}`);
      // 패턴 태깅 실패는 전체 흐름을 중단시키지 않음
    }
  }

  // 학습 현황 댓글 (OPENAI_API_KEY 있을 때만)
  if (env.OPENAI_API_KEY) {
    try {
      await postLearningStatus(
        repoOwner,
        repoName,
        prNumber,
        pr.user.login,
        appToken,
        env.OPENAI_API_KEY
      );
    } catch (error) {
      console.error(`[handlePullRequestEvent] learningStatus failed: ${error.message}`);
      // 학습 현황 실패는 전체 흐름을 중단시키지 않음
    }
  }

  return corsResponse({
    message: "Processed",
    pr: prNumber,
    action,
    week: weekValue,
  });
}

/**
 * 댓글에서 @dalestudy 멘션과 사용자 요청 추출
 *
 * @param {string} commentBody - 댓글 내용
 * @returns {Object|null} { isMentioned, userRequest, isApprovalRequest } 또는 null
 */
function extractMentionAndRequest(commentBody) {
  const lowerBody = commentBody.toLowerCase();
  const isMentioned = lowerBody.includes("@dalestudy");

  if (!isMentioned) {
    return null;
  }

  const mentionMatch = commentBody.match(/@dalestudy\s*(.*)/i);
  let userRequest = mentionMatch && mentionMatch[1].trim() ? mentionMatch[1].trim() : null;

  // 승인 요청 키워드 확인
  const approvalKeywords = ['approve', '승인'];
  const isApprovalRequest = userRequest && approvalKeywords.some(keyword =>
    userRequest.toLowerCase().trim() === keyword
  );

  // 일반적인 리뷰 요청 키워드만 있는 경우 userRequest를 null로 처리
  // (전체 리뷰 모드로 동작하도록)
  if (userRequest && !isApprovalRequest) {
    const normalizedRequest = userRequest.toLowerCase().trim();
    const genericReviewKeywords = [
      'review',
      'review this',
      'please review',
      'review please',
      '리뷰',
      '리뷰해줘',
      '리뷰 해줘',
      '리뷰해주세요',
      '리뷰 해주세요',
      '코드리뷰',
      '코드 리뷰'
    ];

    if (genericReviewKeywords.includes(normalizedRequest)) {
      userRequest = null;
    }
  }

  return { isMentioned: true, userRequest, isApprovalRequest };
}

/**
 * Issue Comment 이벤트 처리 (AI 코드 리뷰 요청 또는 PR 승인 요청)
 */
async function handleIssueCommentEvent(payload, env) {
  const action = payload.action;

  // created 액션만 처리
  if (action !== "created") {
    console.log(`Ignoring issue_comment action: ${action}`);
    return corsResponse({ message: `Ignored: ${action}` });
  }

  console.log(`Processing issue_comment action: ${action}`);

  const comment = payload.comment;
  const issue = payload.issue;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;

  // PR에 달린 댓글인지 확인
  if (!issue.pull_request) {
    console.log("Ignoring: comment not on PR");
    return corsResponse({ message: "Ignored: not a PR comment" });
  }

  const prNumber = issue.number;

  // 멘션 감지 및 사용자 요청 추출
  const mention = extractMentionAndRequest(comment.body);
  if (!mention) {
    console.log("Ignoring: bot not mentioned");
    return corsResponse({ message: "Ignored: not mentioned" });
  }

  const appToken = await generateGitHubAppToken(env);

  // 승인 요청 처리
  if (mention.isApprovalRequest) {
    console.log(`PR approval requested for #${prNumber}`);

    try {
      // 👀 reaction 추가 (처리 시작 알림)
      await addReactionToComment(
        repoOwner,
        repoName,
        comment.id,
        "issue",
        "eyes",
        appToken
      );

      const result = await handleApprovalRequest(
        repoOwner,
        repoName,
        prNumber,
        appToken
      );

      if (result.success) {
        // ✅ reaction 추가 (성공)
        await addReactionToComment(
          repoOwner,
          repoName,
          comment.id,
          "issue",
          "+1",
          appToken
        );

        console.log(`PR #${prNumber} approved successfully`);
        return corsResponse({
          message: "PR approved",
          pr: prNumber,
        });
      } else {
        // ❌ reaction 추가 (실패)
        await addReactionToComment(
          repoOwner,
          repoName,
          comment.id,
          "issue",
          "-1",
          appToken
        );

        console.log(`PR #${prNumber} approval failed: ${result.error}`);
        return corsResponse({
          message: "PR approval failed",
          pr: prNumber,
          error: result.error,
        });
      }
    } catch (error) {
      console.error(`PR approval failed for #${prNumber}:`, error);
      return errorResponse(`PR approval failed: ${error.message}`, 500);
    }
  }

  // AI 코드 리뷰 요청 처리
  console.log(`AI review requested for PR #${prNumber}${mention.userRequest ? ` - Request: ${mention.userRequest}` : ""}`);

  // OPENAI_API_KEY 확인
  if (!env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY not configured");
    return corsResponse({ message: "AI review not configured" });
  }

  // AI 코드 리뷰 실행
  try {
    // 👀 reaction 추가 (리뷰 시작 알림)
    await addReactionToComment(
      repoOwner,
      repoName,
      comment.id,
      "issue",
      "eyes",
      appToken
    );

    await performAIReview(
      repoOwner,
      repoName,
      prNumber,
      issue.title,
      issue.body,
      appToken,
      env.OPENAI_API_KEY,
      mention.userRequest
    );

    console.log(`AI review completed for PR #${prNumber}`);

    return corsResponse({
      message: "AI review posted",
      pr: prNumber,
    });
  } catch (error) {
    console.error(`AI review failed for PR #${prNumber}:`, error);
    return errorResponse(`AI review failed: ${error.message}`, 500);
  }
}

/**
 * Pull Request Review Comment 이벤트 처리 (코드 라인 댓글에 대한 AI 리뷰)
 */
async function handlePullRequestReviewCommentEvent(payload, env) {
  const action = payload.action;

  // created 액션만 처리
  if (action !== "created") {
    console.log(`Ignoring pull_request_review_comment action: ${action}`);
    return corsResponse({ message: `Ignored: ${action}` });
  }

  console.log(`Processing pull_request_review_comment action: ${action}`);

  const comment = payload.comment;
  const pullRequest = payload.pull_request;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const prNumber = pullRequest.number;

  // 멘션 감지 및 사용자 요청 추출
  const mention = extractMentionAndRequest(comment.body);
  if (!mention) {
    console.log("Ignoring: bot not mentioned");
    return corsResponse({ message: "Ignored: not mentioned" });
  }

  console.log(`AI review requested for PR #${prNumber} (review comment)${mention.userRequest ? ` - Request: ${mention.userRequest}` : ""}`);

  // OPENAI_API_KEY 확인
  if (!env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY not configured");
    return corsResponse({ message: "AI review not configured" });
  }

  // AI 코드 리뷰 실행 (스레드 답변)
  try {
    const appToken = await generateGitHubAppToken(env);

    // 👀 reaction 추가
    await addReactionToComment(
      repoOwner,
      repoName,
      comment.id,
      "pull",
      "eyes",
      appToken
    );

    // performAIReview 사용 (스레드 답변 모드)
    await performAIReview(
      repoOwner,
      repoName,
      prNumber,
      pullRequest.title,
      pullRequest.body,
      appToken,
      env.OPENAI_API_KEY,
      mention.userRequest,
      comment.id  // 스레드 답변으로 작성
    );

    console.log(`AI review completed for PR #${prNumber} (thread reply)`);

    return corsResponse({
      message: "AI review posted as thread reply",
      pr: prNumber,
    });
  } catch (error) {
    console.error(`AI review failed for PR #${prNumber}:`, error);
    return errorResponse(`AI review failed: ${error.message}`, 500);
  }
}

/**
 * PR 승인 요청 처리
 *
 * @param {string} repoOwner - 저장소 소유자
 * @param {string} repoName - 저장소 이름
 * @param {number} prNumber - PR 번호
 * @param {string} githubToken - GitHub 토큰
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleApprovalRequest(repoOwner, repoName, prNumber, githubToken) {
  try {
    // PR 정보 조회
    const prResponse = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
      { headers: getGitHubHeaders(githubToken) }
    );

    if (!prResponse.ok) {
      const errorData = await safeJson(prResponse);
      return {
        success: false,
        error: errorData.message || `Failed to fetch PR: ${prResponse.statusText}`,
      };
    }

    const prData = await prResponse.json();

    // Closed PR 체크
    if (isClosedPR(prData.state)) {
      return {
        success: false,
        error: "PR is closed",
      };
    }

    // Draft PR 체크
    if (prData.draft) {
      return {
        success: false,
        error: "PR is in draft state",
      };
    }

    // maintenance 라벨 체크
    const labels = prData.labels.map((l) => l.name);
    if (hasMaintenanceLabel(labels)) {
      return {
        success: false,
        error: "PR has maintenance label",
      };
    }

    // 이미 승인되었는지 확인
    const alreadyApproved = await hasApprovedReview(
      repoOwner,
      repoName,
      prNumber,
      githubToken
    );

    if (alreadyApproved) {
      return {
        success: false,
        error: "PR is already approved",
      };
    }

    // PR 승인 실행
    const approvalResponse = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: {
          ...getGitHubHeaders(githubToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: "승인되었습니다! 👍",
          event: "APPROVE",
        }),
      }
    );

    if (!approvalResponse.ok) {
      const errorData = await safeJson(approvalResponse);
      return {
        success: false,
        error: errorData.message || `Approval failed: ${approvalResponse.statusText}`,
      };
    }

    return { success: true };
  } catch (error) {
    console.error(`handleApprovalRequest error:`, error);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}
