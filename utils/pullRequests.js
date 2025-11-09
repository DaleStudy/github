import { getGitHubHeaders } from "./github.js";

export async function getPullRequestDetails(owner, repo, prNumber, token) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: getGitHubHeaders(token),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to fetch PR #${prNumber}: ${response.status} ${
        errorData.message || response.statusText
      }`
    );
  }

  return await response.json();
}
