/**
 * 학습 현황에 쓰는 데이터 조회
 */

import { getGitHubHeaders } from "./github.js";

const COHORT_PROJECT_PATTERN = /리트코드 스터디\s*\d+기/;

/**
 * 저장소 루트의 problem-categories.json 을 읽는다. 파일이 없으면(404) null.
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {string} appToken
 * @returns {Promise<object|null>}
 */
export async function fetchProblemCategories(repoOwner, repoName, appToken) {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/problem-categories.json`;

  const response = await fetch(url, {
    headers: {
      ...getGitHubHeaders(appToken),
      Accept: "application/vnd.github.raw+json",
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch problem-categories.json: ${response.status} ${response.statusText}`
    );
  }

  return await response.json();
}

/**
 * 진행 중인 기수 프로젝트에 속한, 사용자가 머지한 PR 에서 푼 문제 이름 목록.
 *
 * 머지된 PR 을 최근 순으로 100 개까지 한 번의 GraphQL 검색으로 가져와
 * 열린 "리트코드 스터디 N기" 프로젝트에 속한 PR 만 센다. 한 기수는 100 PR 보다 훨씬 적다.
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {string} username
 * @param {string} appToken
 * @returns {Promise<string[]>}
 */
export async function fetchCohortSolvedProblems(
  repoOwner,
  repoName,
  username,
  appToken
) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...getGitHubHeaders(appToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($q: String!) {
        search(query: $q, type: ISSUE, first: 100) {
          nodes {
            ... on PullRequest {
              projectsV2(first: 10) { nodes { title closed } }
              files(first: 100) { nodes { path } }
            }
          }
        }
      }`,
      variables: {
        q: `repo:${repoOwner}/${repoName} is:pr is:merged author:${username} sort:created-desc`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GraphQL request failed: ${response.status} ${response.statusText}`
    );
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  const solutionPattern = new RegExp(
    `^([^/]+)/${escapeRegExp(username)}\\.[^/]+$`
  );
  const problemNames = new Set();

  for (const pr of result.data.search.nodes) {
    const inActiveCohort = pr.projectsV2?.nodes.some(
      (p) => !p.closed && COHORT_PROJECT_PATTERN.test(p.title)
    );
    if (!inActiveCohort) continue;

    for (const { path } of pr.files?.nodes ?? []) {
      const match = path.match(solutionPattern);
      if (match) problemNames.add(match[1]);
    }
  }

  return [...problemNames];
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
