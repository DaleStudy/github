/**
 * Learning data fetching utilities for DaleStudy GitHub App
 */

import { getGitHubHeaders } from "./github.js";

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
