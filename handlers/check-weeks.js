/**
 * 리트코드 스터디 자동화 핸들러
 */

import { generateGitHubAppToken } from "../utils/github.js";
import { corsResponse, errorResponse } from "../utils/cors.js";

/**
 * 모든 Open PR의 Week 설정을 검사하고 자동으로 댓글 작성/삭제
 *
 * @param {Request} request - Cloudflare Worker request
 * @param {Object} env - Environment variables
 * @returns {Response} CORS가 포함된 JSON 응답
 */
export async function checkWeeks(request, env) {
  try {
    const { repo_owner, repo_name } = await request.json();

    // Validation
    if (!repo_owner || !repo_name) {
      return errorResponse(
        "Missing required fields: repo_owner, repo_name",
        400
      );
    }

    // DaleStudy organization만 허용
    if (repo_owner !== "DaleStudy") {
      return errorResponse("Unauthorized organization", 403);
    }

    // GitHub App Token 생성
    const appToken = await generateGitHubAppToken(env);

    // Open PR 목록 조회
    const prsResponse = await fetch(
      `https://api.github.com/repos/${repo_owner}/${repo_name}/pulls?state=open&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${appToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "DaleStudy-GitHub-App",
        },
      }
    );

    const prs = await prsResponse.json();
    console.log(`Found ${prs.length} open PRs`);

    let checkedCount = 0;
    let commentedCount = 0;
    let deletedCount = 0;
    const results = [];

    // 각 PR 검사
    for (const pr of prs) {
      const prNumber = pr.number;
      const labels = pr.labels.map((l) => l.name);

      // maintenance 라벨이 있으면 스킵
      if (labels.includes("maintenance")) {
        console.log(`Skipping PR #${prNumber}: has maintenance label`);
        continue;
      }

      checkedCount++;

      // Week 설정 확인 (GraphQL)
      const weekQuery = `
        query {
          repository(owner: "${repo_owner}", name: "${repo_name}") {
            pullRequest(number: ${prNumber}) {
              projectItems(first: 10) {
                nodes {
                  project {
                    title
                  }
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
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const weekResponse = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/json",
          "User-Agent": "DaleStudy-GitHub-App",
        },
        body: JSON.stringify({ query: weekQuery }),
      });

      const weekData = await weekResponse.json();
      const projectItems =
        weekData.data?.repository?.pullRequest?.projectItems?.nodes || [];

      let weekValue = null;
      for (const item of projectItems) {
        const fieldValues = item.fieldValues?.nodes || [];
        for (const field of fieldValues) {
          if (
            field.__typename === "ProjectV2ItemFieldIterationValue" &&
            field.field?.name === "Week"
          ) {
            weekValue = field.title;
            break;
          }
        }
        if (weekValue) break;
      }

      // Week 없으면 댓글 작성
      if (!weekValue) {
        const commentBody = `## ⚠️ Week 설정이 누락되었습니다

프로젝트에서 Week를 설정해주세요!

### 설정 방법
1. PR 우측의 \`Projects\` 섹션에서 \`리트코드 스터디\` 옆 드롭다운(▼) 클릭
2. 현재 주차를 선택해주세요 (예: \`Week 14(current)\` 또는 \`Week 14\`)

📚 [자세한 가이드 보기](https://github.com/DaleStudy/leetcode-study/wiki/%EB%8B%B5%EC%95%88-%EC%A0%9C%EC%B6%9C-%EA%B0%80%EC%9D%B4%EB%93%9C#pr-%EC%9E%91%EC%84%B1%EB%B2%95)

---
🤖 이 댓글은 GitHub App을 통해 자동으로 작성되었습니다.`;

        const commentResponse = await fetch(
          `https://api.github.com/repos/${repo_owner}/${repo_name}/issues/${prNumber}/comments`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${appToken}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "User-Agent": "DaleStudy-GitHub-App",
            },
            body: JSON.stringify({ body: commentBody }),
          }
        );

        if (commentResponse.ok) {
          commentedCount++;
          results.push({ pr: prNumber, week: null, commented: true });
          console.log(`Commented on PR #${prNumber}`);
        } else {
          const errorData = await commentResponse.json();
          results.push({
            pr: prNumber,
            week: null,
            commented: false,
            error: errorData.message,
          });
          console.error(`Failed to comment on PR #${prNumber}:`, errorData);
        }
      } else {
        // Week 설정이 있으면 이전 경고 댓글 삭제
        const commentsResponse = await fetch(
          `https://api.github.com/repos/${repo_owner}/${repo_name}/issues/${prNumber}/comments`,
          {
            headers: {
              Authorization: `Bearer ${appToken}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "DaleStudy-GitHub-App",
            },
          }
        );

        if (commentsResponse.ok) {
          const comments = await commentsResponse.json();

          // GitHub App이 작성한 경고 댓글 찾기
          const warningComment = comments.find(
            (comment) =>
              comment.user.type === "Bot" &&
              comment.body.includes("Week 설정이 누락되었습니다")
          );

          if (warningComment) {
            // 댓글 삭제
            const deleteResponse = await fetch(
              `https://api.github.com/repos/${repo_owner}/${repo_name}/issues/comments/${warningComment.id}`,
              {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${appToken}`,
                  Accept: "application/vnd.github+json",
                  "User-Agent": "DaleStudy-GitHub-App",
                },
              }
            );

            if (deleteResponse.ok) {
              deletedCount++;
              console.log(`Deleted warning comment on PR #${prNumber}`);
              results.push({
                pr: prNumber,
                week: weekValue,
                commented: false,
                deleted: true,
              });
            } else {
              console.error(`Failed to delete comment on PR #${prNumber}`);
              results.push({
                pr: prNumber,
                week: weekValue,
                commented: false,
                deleted: false,
              });
            }
          } else {
            results.push({ pr: prNumber, week: weekValue, commented: false });
          }
        } else {
          results.push({ pr: prNumber, week: weekValue, commented: false });
        }

        console.log(`PR #${prNumber}: Week ${weekValue}`);
      }
    }

    return corsResponse({
      success: true,
      total_prs: prs.length,
      checked: checkedCount,
      commented: commentedCount,
      deleted: deletedCount,
      results: results,
    });
  } catch (error) {
    console.error("Worker error:", error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
}
