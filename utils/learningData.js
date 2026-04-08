/**
 * Learning data fetching utilities for DaleStudy GitHub App
 */

import { getGitHubHeaders } from "./github.js";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const COHORT_PROJECT_PATTERN = /리트코드 스터디\s*\d+기/;

/**
 * GitHub GraphQL API 호출 헬퍼
 *
 * @param {string} query
 * @param {string} appToken
 * @returns {Promise<object>}
 */
async function graphql(query, appToken) {
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      ...getGitHubHeaders(appToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

/**
 * 현재 진행 중인 기수 프로젝트 ID를 조회한다.
 * "리트코드 스터디X기" 패턴의 열린 프로젝트를 찾는다.
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {string} appToken
 * @returns {Promise<string|null>} 프로젝트 node ID, 없으면 null
 */
async function fetchActiveCohortProjectId(repoOwner, repoName, appToken) {
  const data = await graphql(
    `{
      repository(owner: "${repoOwner}", name: "${repoName}") {
        projectsV2(first: 20) {
          nodes {
            id
            title
            closed
          }
        }
      }
    }`,
    appToken
  );

  const projects = data.repository.projectsV2.nodes;
  const active = projects.find(
    (p) => !p.closed && COHORT_PROJECT_PATTERN.test(p.title)
  );

  if (!active) {
    console.warn(
      `[fetchActiveCohortProjectId] No open cohort project found for ${repoOwner}/${repoName}`
    );
    return null;
  }

  console.log(
    `[fetchActiveCohortProjectId] Active cohort project: "${active.title}" (${active.id})`
  );
  return active.id;
}

/**
 * 기수 프로젝트의 아이템을 페이지네이션하며 해당 유저가 머지한 PR의
 * 파일 경로를 GraphQL로 한 번에 조회하여 풀이한 문제 이름 목록을 반환한다.
 *
 * PR별 REST 호출 없이 GraphQL 응답에 files를 포함시켜 subrequest를 절약한다.
 *
 * @param {string} projectId
 * @param {string} username
 * @param {string} appToken
 * @returns {Promise<string[]>}
 */
async function fetchCohortSolvedFromProject(projectId, username, appToken) {
  const usernamePattern = new RegExp(
    `^([^/]+)/${escapeRegExp(username)}\\.[^/]+$`
  );
  const problemNames = new Set();
  let cursor = null;

  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const data = await graphql(
      `{
        node(id: "${projectId}") {
          ... on ProjectV2 {
            items(first: 100${afterClause}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                content {
                  ... on PullRequest {
                    state
                    author { login }
                    files(first: 100) {
                      nodes { path }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      appToken
    );

    const { nodes, pageInfo } = data.node.items;

    for (const item of nodes) {
      const pr = item.content;
      if (
        pr?.state === "MERGED" &&
        pr?.author?.login?.toLowerCase() === username.toLowerCase()
      ) {
        for (const file of pr.files?.nodes || []) {
          const match = file.path.match(usernamePattern);
          if (match) {
            problemNames.add(match[1]);
          }
        }
      }
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return Array.from(problemNames);
}

/**
 * 현재 기수 프로젝트에서 해당 유저가 제출한 문제 목록을 반환한다.
 *
 * 기수 프로젝트를 찾지 못하면 전체 레포 트리 스캔(fetchUserSolutions)으로 폴백한다.
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {string} username
 * @param {string} appToken
 * @returns {Promise<string[]>}
 */
export async function fetchCohortUserSolutions(
  repoOwner,
  repoName,
  username,
  appToken
) {
  const projectId = await fetchActiveCohortProjectId(
    repoOwner,
    repoName,
    appToken
  );

  if (!projectId) {
    console.warn(
      `[fetchCohortUserSolutions] Falling back to full tree scan for ${username}`
    );
    return fetchUserSolutions(repoOwner, repoName, username, appToken);
  }

  const problems = await fetchCohortSolvedFromProject(
    projectId,
    username,
    appToken
  );

  console.log(
    `[fetchCohortUserSolutions] ${username} solved ${problems.length} problems in current cohort`
  );

  return problems;
}

/**
 * Fetches problem-categories.json from the repo root via GitHub API.
 * Returns parsed JSON object, or null if the file is not found (404).
 * Throws on other errors.
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
 * Fetches the full repo file tree and returns a deduplicated array of problem
 * names that have a solution file submitted by the given username.
 *
 * Matches files of the form: {problem-name}/{username}.{ext}
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {string} username
 * @param {string} appToken
 * @returns {Promise<string[]>}
 */
export async function fetchUserSolutions(
  repoOwner,
  repoName,
  username,
  appToken
) {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/git/trees/main?recursive=1`;

  const response = await fetch(url, {
    headers: getGitHubHeaders(appToken),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch repo tree: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  if (data.truncated) {
    console.warn(
      `[fetchUserSolutions] Tree response truncated for ${repoOwner}/${repoName}. Results may be incomplete.`
    );
  }

  // Pattern: {problem-name}/{username}.{ext}
  // The path must have exactly two segments and the filename must be username.ext
  const usernamePattern = new RegExp(
    `^([^/]+)/${escapeRegExp(username)}\\.[^/]+$`
  );

  const problemNames = new Set();

  for (const item of data.tree) {
    if (item.type !== "blob") continue;

    const match = item.path.match(usernamePattern);
    if (match) {
      problemNames.add(match[1]);
    }
  }

  return Array.from(problemNames);
}

/**
 * Fetches the files changed in a PR and returns those that match
 * {problem-name}/{username}.{ext} and are added or modified.
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} username
 * @param {string} appToken
 * @returns {Promise<Array<{ problemName: string, filename: string, rawUrl: string }>>}
 */
export async function fetchPRSubmissions(
  repoOwner,
  repoName,
  prNumber,
  username,
  appToken
) {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/files?per_page=100`;

  const response = await fetch(url, {
    headers: getGitHubHeaders(appToken),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PR files: ${response.status} ${response.statusText}`
    );
  }

  const files = await response.json();

  if (files.length === 100) {
    console.warn(
      `[fetchPRSubmissions] PR #${prNumber} has 100+ files. Some submissions may be missed.`
    );
  }

  // Pattern: {problem-name}/{username}.{ext}
  const usernamePattern = new RegExp(
    `^([^/]+)/${escapeRegExp(username)}\\.[^/]+$`
  );

  const results = [];

  for (const file of files) {
    if (file.status !== "added" && file.status !== "modified") continue;

    const match = file.filename.match(usernamePattern);
    if (match) {
      results.push({
        problemName: match[1],
        filename: file.filename,
        rawUrl: file.raw_url,
      });
    }
  }

  return results;
}

/**
 * Escapes special regex characters in a string.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
