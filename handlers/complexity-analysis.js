/**
 * 시간/공간 복잡도 자동 분석 핸들러
 *
 * PR opened/reopened/synchronize 시, 변경된 솔루션 파일들의 시간/공간
 * 복잡도를 OpenAI로 분석하여 PR에 단 하나의 issue 댓글로 upsert 한다.
 */

import { getGitHubHeaders } from "../utils/github.js";
import { hasMaintenanceLabel } from "../utils/validation.js";
import { generateComplexityAnalysis } from "../utils/openai.js";

const COMMENT_MARKER = "<!-- dalestudy-complexity-analysis -->";
const SOLUTION_PATH_REGEX = /^[^/]+\/[^/]+\.[^.]+$/;
const MAX_FILE_SIZE = 15000; // 15K 문자 제한 (OpenAI 토큰 안전장치)

/**
 * PR의 솔루션 파일들에 대해 시간/공간 복잡도 분석 댓글을 작성한다.
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {object} prData - PR 객체 (draft, labels 포함)
 * @param {string} appToken - GitHub App installation token
 * @param {string} openaiApiKey
 */
export async function analyzeComplexity(
  repoOwner,
  repoName,
  prNumber,
  prData,
  appToken,
  openaiApiKey
) {
  // Skip 조건
  if (prData.draft === true) {
    console.log(`[complexity] Skipping PR #${prNumber}: draft`);
    return { skipped: "draft" };
  }

  const labels = (prData.labels || []).map((l) => l.name);
  if (hasMaintenanceLabel(labels)) {
    console.log(`[complexity] Skipping PR #${prNumber}: maintenance label`);
    return { skipped: "maintenance" };
  }

  // 1) PR 변경 파일 목록 조회
  const filesResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/files?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!filesResponse.ok) {
    throw new Error(
      `Failed to list PR files: ${filesResponse.status} ${filesResponse.statusText}`
    );
  }

  const allFiles = await filesResponse.json();
  const solutionFiles = allFiles.filter(
    (f) =>
      (f.status === "added" || f.status === "modified") &&
      SOLUTION_PATH_REGEX.test(f.filename)
  );

  console.log(
    `[complexity] PR #${prNumber}: ${allFiles.length} files, ${solutionFiles.length} solution files`
  );

  if (solutionFiles.length === 0) {
    return { skipped: "no-solution-files" };
  }

  // 2) 파일별 분석 (각 파일 try/catch — 한 파일 실패가 전체를 막지 않음)
  const entries = [];
  for (const file of solutionFiles) {
    const problemName = file.filename.split("/")[0];

    try {
      const rawResponse = await fetch(file.raw_url);
      if (!rawResponse.ok) {
        throw new Error(
          `Failed to fetch raw content: ${rawResponse.status} ${rawResponse.statusText}`
        );
      }

      let fileContent = await rawResponse.text();
      if (fileContent.length > MAX_FILE_SIZE) {
        fileContent = fileContent.slice(0, MAX_FILE_SIZE);
        console.log(
          `[complexity] Truncated ${file.filename} to ${MAX_FILE_SIZE} chars`
        );
      }

      const analysis = await generateComplexityAnalysis(
        fileContent,
        problemName,
        openaiApiKey
      );

      entries.push({ problemName, analysis });
    } catch (error) {
      console.error(
        `[complexity] Failed to analyze ${file.filename}: ${error.message}`
      );
      entries.push({ problemName, analysis: null, error: error.message });
    }
  }

  // 3) 댓글 본문 빌드 + upsert
  const body = formatCommentBody(entries);
  await upsertComment(repoOwner, repoName, prNumber, body, appToken);

  return {
    analyzed: entries.filter((e) => e.analysis).length,
    failed: entries.filter((e) => e.error).length,
  };
}

/**
 * 마커가 포함된 Bot 댓글인지 확인
 */
function isComplexityComment(comment) {
  return (
    comment.user?.type === "Bot" && comment.body?.includes(COMMENT_MARKER)
  );
}

/**
 * 분석 결과들을 하나의 마크다운 댓글 본문으로 포맷한다.
 *
 * @param {Array<{
 *   problemName: string,
 *   analysis: {
 *     hasUserAnnotation: boolean,
 *     userTime: string|null,
 *     userSpace: string|null,
 *     actualTime: string,
 *     actualSpace: string,
 *     matches: { time: boolean, space: boolean },
 *     feedback: string,
 *     suggestion: string
 *   } | null,
 *   error?: string
 * }>} entries
 * @returns {string}
 */
function formatCommentBody(entries) {
  const lines = [];

  lines.push(COMMENT_MARKER);
  lines.push("### 📊 시간/공간 복잡도 분석");
  lines.push("");

  for (const { problemName, analysis, error } of entries) {
    lines.push(`### ${problemName}`);
    lines.push("");

    if (error || !analysis) {
      lines.push(`> ⚠️ 분석 실패: ${error || "알 수 없는 오류"}`);
      lines.push("");
      continue;
    }

    if (analysis.hasUserAnnotation) {
      // 케이스 1/2: 비교 표
      const timeMark = analysis.userTime
        ? analysis.matches.time
          ? "✅"
          : "❌"
        : "-";
      const spaceMark = analysis.userSpace
        ? analysis.matches.space
          ? "✅"
          : "❌"
        : "-";

      lines.push("| | 유저 분석 | 실제 분석 | 결과 |");
      lines.push("|---|---|---|---|");
      lines.push(
        `| **Time** | ${analysis.userTime ?? "-"} | ${analysis.actualTime} | ${timeMark} |`
      );
      lines.push(
        `| **Space** | ${analysis.userSpace ?? "-"} | ${analysis.actualSpace} | ${spaceMark} |`
      );
    } else {
      // 케이스 3: 분석값만
      lines.push("| | 복잡도 |");
      lines.push("|---|---|");
      lines.push(`| **Time** | ${analysis.actualTime} |`);
      lines.push(`| **Space** | ${analysis.actualSpace} |`);
    }

    lines.push("");

    if (analysis.feedback) {
      lines.push(`**피드백**: ${analysis.feedback}`);
      lines.push("");
    }

    if (analysis.suggestion) {
      lines.push(`**개선 제안**: ${analysis.suggestion}`);
      lines.push("");
    }

    if (!analysis.hasUserAnnotation) {
      lines.push("> 💡 풀이에 시간/공간 복잡도를 주석으로 남겨보세요!");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("🤖 이 댓글은 GitHub App을 통해 자동으로 작성되었습니다.");

  return lines.join("\n") + "\n";
}

/**
 * 복잡도 분석 댓글을 생성하거나 기존 댓글을 업데이트한다.
 */
async function upsertComment(repoOwner, repoName, prNumber, commentBody, appToken) {
  const baseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}`;

  const listResponse = await fetch(
    `${baseUrl}/issues/${prNumber}/comments?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!listResponse.ok) {
    throw new Error(
      `[complexity] Failed to list comments on PR #${prNumber}: ${listResponse.status} ${listResponse.statusText}`
    );
  }

  const comments = await listResponse.json();
  const existing = comments.find(isComplexityComment);

  const headers = {
    ...getGitHubHeaders(appToken),
    "Content-Type": "application/json",
  };

  if (existing) {
    console.log(
      `[complexity] Updating existing comment ${existing.id} on PR #${prNumber}`
    );

    const patchResponse = await fetch(
      `${baseUrl}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body: commentBody }),
      }
    );

    if (!patchResponse.ok) {
      const errorText = await patchResponse.text();
      throw new Error(
        `[complexity] Failed to update comment ${existing.id} on PR #${prNumber}: ${patchResponse.status} ${errorText}`
      );
    }

    console.log(
      `[complexity] Updated comment ${existing.id} on PR #${prNumber}`
    );
  } else {
    console.log(
      `[complexity] Posting new complexity comment on PR #${prNumber}`
    );

    const postResponse = await fetch(
      `${baseUrl}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body: commentBody }),
      }
    );

    if (!postResponse.ok) {
      const errorText = await postResponse.text();
      throw new Error(
        `[complexity] Failed to post comment on PR #${prNumber}: ${postResponse.status} ${errorText}`
      );
    }

    console.log(`[complexity] Created new comment on PR #${prNumber}`);
  }
}
