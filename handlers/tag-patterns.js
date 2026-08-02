/**
 * 알고리즘 패턴 태깅 핸들러
 *
 * PR의 솔루션 파일들을 분석하여 사용된 알고리즘 패턴 + 시간/공간 복잡도를
 * 파일별 review comment로 남긴다. 복잡도 분석은 패턴 분석 루프와 병렬로
 * OpenAI 1콜에서 모든 파일을 한 번에 처리하고, 그 결과를 파일별 댓글
 * 본문에 한 섹션 더 붙이는 형태로 묻어간다.
 * 재실행 시 기존 패턴 댓글과 답글은 보존하고, 변경된 파일에 새 분석 댓글을 추가한다.
 *
 * 주의: Workers Free 플랜의 외부 subrequest 한도는 invocation당 50회이므로 준수해야 한다.
 * @see https://developers.cloudflare.com/workers/platform/limits/#subrequests
 */

import { getGitHubHeaders } from "../utils/github.js";
import { createCodeFence } from "../utils/markdown.js";
import { hasMaintenanceLabel } from "../utils/validation.js";
import { generatePatternAnalysis } from "../utils/openai.js";
import {
  callComplexityAnalysis,
  renderComplexitySection,
} from "./complexity-analysis.js";

const COMMENT_MARKER = "<!-- dalestudy-pattern-tag -->";
// 레거시 단독 복잡도 issue comment 식별용. 새 합본 댓글에는 박지 않는다.
const LEGACY_COMPLEXITY_MARKER = "<!-- dalestudy-complexity-analysis -->";
const SOLUTION_PATH_REGEX = /^[^/]+\/[^/]+\.[^.]+$/;
const MAX_FILE_CONTENT_LENGTH = 20000; // OpenAI 입력 크기 안전장치

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

  // 2-3. 모든 파일 raw 다운로드 (한 번만, 복잡도 분석과 공유)
  const fileEntries = await downloadFileEntries(solutionFiles);

  // 2-4. 복잡도 분석은 1콜이므로 패턴 루프와 병렬 진행. 실패해도 패턴 댓글은 작성.
  const complexityPromise = callComplexityAnalysis(fileEntries, openaiApiKey)
    .catch((err) => {
      console.error(`[tagPatterns] complexity analysis failed: ${err.message}`);
      return [];
    });

  // 2-5. 파일별 OpenAI 분석 + 코멘트 작성 (각 파일 try/catch 래핑)
  const results = [];
  for (const fe of fileEntries) {
    try {
      const result = await tagSingleFile(
        fe,
        complexityPromise,
        repoOwner,
        repoName,
        prNumber,
        headSha,
        appToken,
        openaiApiKey
      );
      results.push({ path: fe.file.filename, ...result });
    } catch (error) {
      console.error(
        `[tagPatterns] Failed to tag ${fe.file.filename}: ${error.message}`
      );
      results.push({ path: fe.file.filename, error: error.message });
    }
  }

  // 2-6. 마이그레이션: 구버전이 남긴 단독 복잡도 issue comment 가 있으면 삭제
  await deleteLegacyComplexityIssueComment(
    repoOwner, repoName, prNumber, appToken
  );

  return { tagged: results.filter((r) => !r.error).length, results };
}

/**
 * 단일 파일 분석 + 코멘트 작성
 *
 * @param {{file: object, problemName: string, content: string, isContentTruncated: boolean}} fileEntry
 * @param {Promise<Array>} complexityPromise - 모든 파일의 복잡도 분석 결과 (병렬 진행)
 */
async function tagSingleFile(
  fileEntry,
  complexityPromise,
  repoOwner,
  repoName,
  prNumber,
  headSha,
  appToken,
  openaiApiKey
) {
  const {
    file,
    problemName,
    content: fileContent,
    isContentTruncated,
  } = fileEntry;

  // OpenAI 패턴 분석
  const analysis = await generatePatternAnalysis(
    fileContent,
    problemName,
    openaiApiKey
  );

  // 코멘트 본문 작성
  const patternsText =
    analysis.patterns.length > 0 ? analysis.patterns.join(", ") : "감지된 패턴 없음";
  let body = `${COMMENT_MARKER}
### 🏷️ 알고리즘 패턴 분석

${renderAnalyzedSource(file.filename, fileContent, isContentTruncated)}

- **패턴**: ${patternsText}
- **설명**: ${analysis.description || "(설명 없음)"}`;

  // 복잡도 섹션을 한 블록 더 붙인다 (해당 파일 결과가 있을 때만, 실패 시 스킵)
  const complexityResults = await complexityPromise;
  const complexityForFile = complexityResults.find(
    (r) => r.problemName === problemName
  );
  if (complexityForFile && complexityForFile.solutions.length > 0) {
    body += "\n\n" + renderComplexitySection(complexityForFile);
  }

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

function renderAnalyzedSource(filename, content, isContentTruncated) {
  const language = filename.includes(".") ? filename.split(".").pop() : "";
  const truncationNotice = isContentTruncated ? "\n... (이하 생략)" : "";
  const codeFence = createCodeFence(content);

  return `<details>
<summary>${filename}</summary>

${codeFence}${language}
${content}${truncationNotice}
${codeFence}

</details>`;
}

/**
 * 솔루션 파일들의 raw 내용을 한 번에 다운로드한다.
 * 패턴 분석 + 복잡도 분석이 같은 fileEntries 를 공유한다.
 */
async function downloadFileEntries(solutionFiles) {
  return Promise.all(
    solutionFiles.map(async (file) => {
      const res = await fetch(file.raw_url);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch raw content for ${file.filename}: ${res.status}`
        );
      }
      let content = await res.text();
      const isContentTruncated = content.length > MAX_FILE_CONTENT_LENGTH;
      if (isContentTruncated) {
        content = content.slice(0, MAX_FILE_CONTENT_LENGTH);
        console.log(
          `[tagPatterns] Truncated ${file.filename} to ${MAX_FILE_CONTENT_LENGTH} chars`
        );
      }
      return {
        file,
        problemName: file.filename.split("/")[0],
        content,
        isContentTruncated,
      };
    })
  );
}

/**
 * 구버전 단독 복잡도 issue comment 가 있으면 삭제한다 (마이그레이션).
 * 새 코드는 review comment 에 합본으로 작성하므로 단독 issue comment 는 중복.
 */
async function deleteLegacyComplexityIssueComment(
  repoOwner,
  repoName,
  prNumber,
  appToken
) {
  const listResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!listResponse.ok) {
    console.error(
      `[tagPatterns] Failed to list issue comments for legacy cleanup: ${listResponse.status}`
    );
    return;
  }

  const comments = await listResponse.json();
  const legacy = comments.find(
    (c) =>
      c.user?.type === "Bot" && c.body?.includes(LEGACY_COMPLEXITY_MARKER)
  );

  if (!legacy) return;

  try {
    const deleteResponse = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/issues/comments/${legacy.id}`,
      {
        method: "DELETE",
        headers: getGitHubHeaders(appToken),
      }
    );

    if (!deleteResponse.ok) {
      console.error(
        `[tagPatterns] Failed to delete legacy complexity comment ${legacy.id}: ${deleteResponse.status}`
      );
      return;
    }

    console.log(
      `[tagPatterns] Deleted legacy complexity issue comment ${legacy.id} on PR #${prNumber}`
    );
  } catch (error) {
    console.error(
      `[tagPatterns] Error deleting legacy complexity comment ${legacy.id}: ${error.message}`
    );
  }
}
