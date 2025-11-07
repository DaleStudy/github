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
import { performAIReview } from "../utils/prReview.js";

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
 * Pull Request 이벤트 처리 (PR 생성 시 즉시 체크)
 */
async function handlePullRequestEvent(payload, env) {
  const action = payload.action;

  // opened, reopened 액션만 처리
  if (!["opened", "reopened"].includes(action)) {
    console.log(`Ignoring pull_request action: ${action}`);
    return corsResponse({ message: `Ignored: ${action}` });
  }

  console.log(`Processing pull_request action: ${action}`);

  const pr = payload.pull_request;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const prNumber = pr.number;

  // maintenance 라벨 체크
  const labels = pr.labels.map((l) => l.name);
  if (hasMaintenanceLabel(labels)) {
    console.log(`Skipping PR #${prNumber}: has maintenance label`);
    return corsResponse({ message: "Ignored: maintenance label" });
  }

  console.log(`New PR opened: #${prNumber}`);

  // Week 설정 확인 및 댓글 작성 (아직 Week 설정 안 되어 있을 가능성 높음)
  // 잠시 대기 후 체크 (프로젝트 추가 시간 고려)
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const appToken = await generateGitHubAppToken(env);
  const weekValue = await handleWeekComment(
    repoOwner,
    repoName,
    prNumber,
    env,
    appToken
  );

  return corsResponse({
    message: "Processed",
    pr: prNumber,
    week: weekValue,
  });
}

/**
 * Issue Comment 이벤트 처리 (AI 코드 리뷰 요청)
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

  // 멘션 감지: @dalestudy만 체크
  const commentBody = comment.body.toLowerCase();
  const isMentioned = commentBody.includes("@dalestudy");

  if (!isMentioned) {
    console.log("Ignoring: bot not mentioned");
    return corsResponse({ message: "Ignored: not mentioned" });
  }

  console.log(`AI review requested for PR #${prNumber}`);

  // OPENAI_API_KEY 확인
  if (!env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY not configured");
    return corsResponse({ message: "AI review not configured" });
  }

  // AI 코드 리뷰 실행
  try {
    const appToken = await generateGitHubAppToken(env);

    await performAIReview(
      repoOwner,
      repoName,
      prNumber,
      issue.title,
      issue.body,
      appToken,
      env.OPENAI_API_KEY,
      comment.id  // 원본 댓글 ID 전달
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
