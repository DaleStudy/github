/**
 * PR Week 설정 관련 유틸리티
 */

import { generateGitHubAppToken, getGitHubHeaders } from "./github.js";

/**
 * PR의 프로젝트 필드 값(Week, Status)과 CI 롤업 상태 조회
 *
 * 자동 승인·병합이 세 값을 모두 보므로 한 번의 GraphQL 호출로 묶는다.
 *
 * @returns {Promise<{week: string|null, status: string|null, checkState: string|null}>}
 */
export async function getPrFields(repoOwner, repoName, prNumber, appToken) {
  const query = `
    query {
      repository(owner: "${repoOwner}", name: "${repoName}") {
        pullRequest(number: ${prNumber}) {
          projectItems(first: 10) {
            nodes {
              fieldValues(first: 20) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldIterationValue {
                    title
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...getGitHubHeaders(appToken), "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  const pullRequest = data.data?.repository?.pullRequest;
  const projectItems = pullRequest?.projectItems?.nodes || [];

  const result = {
    week: null,
    status: null,
    checkState:
      pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  };

  for (const item of projectItems) {
    const fieldValues = item.fieldValues?.nodes || [];
    for (const field of fieldValues) {
      // Week 필드 (Iteration 타입)
      if (
        field.__typename === "ProjectV2ItemFieldIterationValue" &&
        field.field?.name === "Week"
      ) {
        result.week = field.title;
      }
      // Status 필드 (SingleSelect 타입)
      if (
        field.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
        field.field?.name === "Status"
      ) {
        result.status = field.name;
      }
    }
  }

  return result;
}

/**
 * 경고 댓글 내용
 */
const WARNING_COMMENT_BODY = `## ⚠️ Week 설정이 누락되었습니다

프로젝트에서 Week를 설정해주세요!

### 설정 방법
1. PR 우측의 \`Projects\` 섹션에서 \`리트코드 스터디\` 옆 드롭다운(▼) 클릭
2. 현재 주차를 선택해주세요 (예: \`Week 14(current)\` 또는 \`Week 14\`)

📚 [자세한 가이드 보기](https://github.com/DaleStudy/leetcode-study/wiki/%EB%8B%B5%EC%95%88-%EC%A0%9C%EC%B6%9C-%EA%B0%80%EC%9D%B4%EB%93%9C#pr-%EC%9E%91%EC%84%B1%EB%B2%95)

---
🤖 이 댓글은 GitHub App을 통해 자동으로 작성되었습니다.`;

/**
 * 경고 댓글인지 확인
 */
function isWarningComment(comment) {
  return (
    comment.user.type === "Bot" &&
    comment.body.includes("Week 설정이 누락되었습니다")
  );
}

/**
 * 경고 댓글 작성 (중복 방지)
 */
export async function ensureWarningComment(repoOwner, repoName, prNumber, env) {
  const appToken = await generateGitHubAppToken(env);

  // 기존 경고 댓글 확인
  const commentsResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (commentsResponse.ok) {
    const comments = await commentsResponse.json();
    const hasWarning = comments.some(isWarningComment);

    if (hasWarning) {
      console.log(`PR #${prNumber} already has warning comment, skipping...`);
      return false;
    }
  }

  // 경고 댓글 작성
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: { ...getGitHubHeaders(appToken), "Content-Type": "application/json" },
      body: JSON.stringify({ body: WARNING_COMMENT_BODY }),
    }
  );

  if (response.ok) {
    console.log(`Created warning comment on PR #${prNumber}`);
    return true;
  } else {
    const errorData = await response.json();
    console.error(`Failed to create comment on PR #${prNumber}:`, errorData);
    return false;
  }
}

/**
 * 경고 댓글 삭제
 */
export async function removeWarningComment(repoOwner, repoName, prNumber, env) {
  const appToken = await generateGitHubAppToken(env);

  const commentsResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!commentsResponse.ok) {
    return false;
  }

  const comments = await commentsResponse.json();
  const warningComment = comments.find(isWarningComment);

  if (!warningComment) {
    return false;
  }

  const deleteResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/comments/${warningComment.id}`,
    {
      method: "DELETE",
      headers: getGitHubHeaders(appToken),
    }
  );

  if (deleteResponse.ok) {
    console.log(`Deleted warning comment on PR #${prNumber}`);
    return true;
  } else {
    console.error(`Failed to delete comment on PR #${prNumber}`);
    return false;
  }
}

/**
 * Week 값을 확인하고 자동으로 댓글 작성/삭제
 *
 * @returns {Promise<string|null>} Week 값 또는 null
 */
export async function handleWeekComment(repoOwner, repoName, prNumber, env, appToken) {
  const fields = await getPrFields(repoOwner, repoName, prNumber, appToken);
  const weekValue = fields.week;

  if (!weekValue) {
    await ensureWarningComment(repoOwner, repoName, prNumber, env);
  } else {
    await removeWarningComment(repoOwner, repoName, prNumber, env);
  }

  return weekValue;
}
