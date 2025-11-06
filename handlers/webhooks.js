/**
 * GitHub Webhook 이벤트 핸들러
 */

import { generateGitHubAppToken } from "../utils/github.js";
import { corsResponse, errorResponse } from "../utils/cors.js";
import {
  getWeekValue,
  ensureWarningComment,
  removeWarningComment,
} from "../utils/prWeeks.js";

/**
 * GitHub webhook 이벤트 처리
 *
 * @param {Request} request - Cloudflare Worker request
 * @param {Object} env - Environment variables
 * @returns {Response} CORS가 포함된 JSON 응답
 */
export async function handleWebhook(request, env) {
  try {
    const payload = await request.json();
    const eventType = request.headers.get("X-GitHub-Event");

    console.log(`Received webhook event: ${eventType}`);

    // DaleStudy organization만 허용
    const orgLogin = payload.organization?.login;
    if (orgLogin !== "DaleStudy") {
      console.log(`Ignoring event from organization: ${orgLogin}`);
      return corsResponse({ message: "Ignored: not DaleStudy organization" });
    }

    // 이벤트 타입별 처리
    switch (eventType) {
      case "projects_v2_item":
        return handleProjectsV2ItemEvent(payload, env);

      case "pull_request":
        return handlePullRequestEvent(payload, env);

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

  // edited, created 액션만 처리
  if (!["edited", "created"].includes(action)) {
    console.log(`Ignoring projects_v2_item action: ${action}`);
    return corsResponse({ message: `Ignored: ${action}` });
  }

  // PR과 연결된 item인지 확인
  const contentType = payload.projects_v2_item?.content_type;
  if (contentType !== "PullRequest") {
    console.log(`Ignoring non-PR item: ${contentType}`);
    return corsResponse({ message: "Ignored: not a PR" });
  }

  // Week 필드 변경인지 확인
  const changes = payload.changes;
  const isWeekField =
    changes?.field_value?.field_name === "Week" ||
    changes?.field_value?.from?.field_name === "Week";

  if (!isWeekField) {
    console.log("Ignoring: not a Week field change");
    return corsResponse({ message: "Ignored: not Week field" });
  }

  // PR 정보 추출
  const prUrl = payload.projects_v2_item?.content_url;
  if (!prUrl) {
    console.log("No PR URL found");
    return corsResponse({ message: "Ignored: no PR URL" });
  }

  // PR URL에서 repo와 PR number 추출
  // URL 형식: https://api.github.com/repos/DaleStudy/leetcode-study/pulls/1970
  const matches = prUrl.match(
    /https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/
  );
  if (!matches) {
    console.log(`Invalid PR URL: ${prUrl}`);
    return errorResponse("Invalid PR URL", 400);
  }

  const [, repoOwner, repoName, prNumber] = matches;
  const weekValue = payload.projects_v2_item?.field_value?.text || null;

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

  const pr = payload.pull_request;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const prNumber = pr.number;

  // maintenance 라벨 체크
  const labels = pr.labels.map((l) => l.name);
  if (labels.includes("maintenance")) {
    console.log(`Skipping PR #${prNumber}: has maintenance label`);
    return corsResponse({ message: "Ignored: maintenance label" });
  }

  console.log(`New PR opened: #${prNumber}`);

  // Week 설정 확인 및 댓글 작성 (아직 Week 설정 안 되어 있을 가능성 높음)
  // 잠시 대기 후 체크 (프로젝트 추가 시간 고려)
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const appToken = await generateGitHubAppToken(env);
  const weekValue = await getWeekValue(repoOwner, repoName, prNumber, appToken);

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
