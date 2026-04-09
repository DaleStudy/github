/**
 * 알고리즘 패턴 태깅 핸들러
 *
 * PR의 솔루션 파일들을 분석하여 사용된 알고리즘 패턴을
 * 파일별 review comment로 남긴다.
 */

import { getGitHubHeaders } from "../utils/github.js";
import { hasMaintenanceLabel } from "../utils/validation.js";
import { generatePatternAnalysis } from "../utils/openai.js";

const COMMENT_MARKER = "<!-- dalestudy-pattern-tag -->";
const SOLUTION_PATH_REGEX = /^[^/]+\/[^/]+\.[^.]+$/;
const MAX_FILE_SIZE = 20000; // 20K 문자 제한 (OpenAI 토큰 안전장치)

/**
 * PR의 솔루션 파일들에 알고리즘 패턴 태그 달기
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} headSha - PR head commit SHA
 * @param {object} prData - PR 객체 (draft, labels 포함)
 * @param {string} appToken - GitHub App installation token
 * @param {string} openaiApiKey
 * @param {string[]|null} [changedFilenames=null] - synchronize 시 변경된 파일명 목록 (null이면 전체 분석)
 */
export async function tagPatterns(
  repoOwner,
  repoName,
  prNumber,
  headSha,
  prData,
  appToken,
  openaiApiKey,
  changedFilenames = null
) {
  // 2-1. Skip 조건
  if (prData.draft === true) {
    console.log(`[tagPatterns] Skipping PR #${prNumber}: draft`);
    return { skipped: "draft" };
  }

  const labels = (prData.labels || []).map((l) => l.name);
  if (hasMaintenanceLabel(labels)) {
    console.log(`[tagPatterns] Skipping PR #${prNumber}: maintenance label`);
    return { skipped: "maintenance" };
  }

  // 2-2. PR 변경 파일 목록 조회 + 필터링
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
  let solutionFiles = allFiles.filter(
    (f) =>
      (f.status === "added" || f.status === "modified") &&
      SOLUTION_PATH_REGEX.test(f.filename)
  );

  // changedFilenames가 제공되면 해당 파일만 대상으로 좁힘 (synchronize 최적화)
  if (changedFilenames !== null) {
    const changedSet = new Set(changedFilenames);
    solutionFiles = solutionFiles.filter((f) => changedSet.has(f.filename));
    console.log(
      `[tagPatterns] PR #${prNumber}: narrowed to ${solutionFiles.length} changed solution files`
    );
  }

  console.log(
    `[tagPatterns] PR #${prNumber}: ${allFiles.length} total files, ${solutionFiles.length} solution files to analyze`
  );

  if (solutionFiles.length === 0) {
    return { skipped: "no-solution-files" };
  }

  // 2-3. 기존 Bot 패턴 태그 코멘트 삭제 (변경 파일만)
  const targetFilenames = solutionFiles.map((f) => f.filename);
  await deletePreviousPatternComments(
    repoOwner, repoName, prNumber, appToken, targetFilenames
  );

  // 2-4. 파일별 OpenAI 분석 + 코멘트 작성 (각 파일 try/catch 래핑)
  const results = [];
  for (const file of solutionFiles) {
    try {
      const result = await tagSingleFile(
        file,
        repoOwner,
        repoName,
        prNumber,
        headSha,
        appToken,
        openaiApiKey
      );
      results.push({ path: file.filename, ...result });
    } catch (error) {
      console.error(
        `[tagPatterns] Failed to tag ${file.filename}: ${error.message}`
      );
      results.push({ path: file.filename, error: error.message });
    }
  }

  return { tagged: results.filter((r) => !r.error).length, results };
}

/**
 * 기존 Bot 패턴 태그 코멘트 삭제 (대상 파일만, 다른 사용자 코멘트는 절대 건드리지 않음)
 *
 * @param {string[]} targetFilenames - 삭제 대상 파일명 목록
 */
async function deletePreviousPatternComments(
  repoOwner,
  repoName,
  prNumber,
  appToken,
  targetFilenames
) {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!response.ok) {
    console.error(
      `[tagPatterns] Failed to fetch review comments: ${response.status}`
    );
    return;
  }

  const comments = await response.json();
  const targetSet = new Set(targetFilenames);
  const botPatternComments = comments.filter(
    (c) =>
      c.user?.type === "Bot" &&
      c.body?.includes(COMMENT_MARKER) &&
      targetSet.has(c.path)
  );

  for (const comment of botPatternComments) {
    try {
      const deleteResponse = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/comments/${comment.id}`,
        {
          method: "DELETE",
          headers: getGitHubHeaders(appToken),
        }
      );

      if (!deleteResponse.ok) {
        console.error(
          `[tagPatterns] Failed to delete comment ${comment.id}: ${deleteResponse.status}`
        );
      }
    } catch (error) {
      console.error(
        `[tagPatterns] Error deleting comment ${comment.id}: ${error.message}`
      );
    }
  }

  console.log(
    `[tagPatterns] Deleted ${botPatternComments.length} previous pattern comments for ${targetFilenames.length} files`
  );
}

/**
 * 단일 파일 분석 + 코멘트 작성
 */
async function tagSingleFile(
  file,
  repoOwner,
  repoName,
  prNumber,
  headSha,
  appToken,
  openaiApiKey
) {
  // 파일 내용 가져오기
  const contentResponse = await fetch(file.raw_url);
  if (!contentResponse.ok) {
    throw new Error(`Failed to fetch raw content: ${contentResponse.status}`);
  }

  let fileContent = await contentResponse.text();
  if (fileContent.length > MAX_FILE_SIZE) {
    fileContent = fileContent.slice(0, MAX_FILE_SIZE);
    console.log(
      `[tagPatterns] Truncated ${file.filename} to ${MAX_FILE_SIZE} chars`
    );
  }

  // 폴더명(=문제 이름) 추출
  const problemName = file.filename.split("/")[0];

  // OpenAI 패턴 분석
  const analysis = await generatePatternAnalysis(
    fileContent,
    problemName,
    openaiApiKey
  );

  // 코멘트 본문 작성
  const patternsText =
    analysis.patterns.length > 0 ? analysis.patterns.join(", ") : "감지된 패턴 없음";
  const body = `${COMMENT_MARKER}
### 🏷️ 알고리즘 패턴 분석

- **패턴**: ${patternsText}
- **설명**: ${analysis.description || "(설명 없음)"}`;

  // 파일 단위 review comment 작성
  const commentResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        ...getGitHubHeaders(appToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body,
        commit_id: headSha,
        path: file.filename,
        subject_type: "file",
      }),
    }
  );

  if (!commentResponse.ok) {
    const errorText = await commentResponse.text();
    throw new Error(
      `Failed to post review comment: ${commentResponse.status} ${errorText}`
    );
  }

  return { patterns: analysis.patterns };
}
