/**
 * AI 리뷰 핸들러
 *
 * PR의 솔루션 파일들을 AI로 리뷰해 알고리즘 패턴, 의도한 접근법 일치 여부,
 * 시간/공간 복잡도, 작성자의 학습 현황을 PR head 커밋의 check run 하나로 남긴다.
 * 사람 리뷰와 섞이지 않도록 리뷰 댓글은 달지 않고, 대화 탭에는 check run 링크 댓글 하나만 유지한다.
 * 복잡도 분석(1콜)과 기수 풀이 조회는 파일별 패턴 분석 루프와 병렬로 진행한다.
 *
 * 주의: Workers Free 플랜의 외부 subrequest 한도는 invocation당 50회이므로 준수해야 한다.
 * @see https://developers.cloudflare.com/workers/platform/limits/#subrequests
 */

import { getGitHubHeaders } from "../utils/github.js";
import { generatePatternAnalysis } from "../utils/openai.js";
import {
  fetchProblemCategories,
  fetchCohortSolvedProblems,
} from "../utils/learningData.js";
import { renderLearningStatus } from "../utils/learningStatus.js";
import {
  callComplexityAnalysis,
  renderComplexitySection,
} from "./complexity-analysis.js";

const CHECK_RUN_NAME = "AI 리뷰";
const LINK_COMMENT_MARKER = "<!-- dalestudy-ai-analysis-link -->";
// 예전에 issue comment 로 달던 결과물. 보이면 지운다.
const LEGACY_COMMENT_MARKERS = [
  "<!-- dalestudy-complexity-analysis -->",
  "<!-- dalestudy-learning-status -->",
];
const SOLUTION_PATH_REGEX = /^[^/]+\/[^/]+\.[^.]+$/;
const MAX_FILE_CONTENT_LENGTH = 20000; // OpenAI 입력 크기 안전장치
// check run output.summary / output.text 의 최대 길이
const MAX_CHECK_RUN_OUTPUT_LENGTH = 65535;

/**
 * PR의 솔루션 파일들을 AI로 리뷰해 check run 으로 게시하기
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} headSha - PR head commit SHA
 * @param {object} prData - PR 객체 (draft, user 포함)
 * @param {string} appToken - GitHub App installation token
 * @param {Ai} ai - Worker 의 AI 바인딩 (env.AI)
 */
export async function aiReview(
  repoOwner,
  repoName,
  prNumber,
  headSha,
  prData,
  appToken,
  ai
) {
  if (prData.draft === true) {
    console.log(`[aiReview] Skipping PR #${prNumber}: draft`);
    return { skipped: "draft" };
  }

  // PR 변경 파일 목록 조회 + 필터링
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
    `[aiReview] PR #${prNumber}: ${allFiles.length} total files, ${solutionFiles.length} solution files to analyze`
  );

  if (solutionFiles.length === 0) {
    return { skipped: "no-solution-files" };
  }

  // 파일 raw 내용과 문제 정보를 함께 받는다. 문제 정보가 없어도 리뷰는 계속한다.
  const [fileEntries, categories] = await Promise.all([
    downloadFileEntries(solutionFiles),
    fetchProblemCategories(repoOwner, repoName, appToken).catch((err) => {
      console.error(`[aiReview] problem categories fetch failed: ${err.message}`);
      return null;
    }),
  ]);

  // 복잡도 분석(1콜)과 기수 풀이 조회는 패턴 루프와 병렬 진행. 실패해도 나머지는 게시.
  const complexityPromise = callComplexityAnalysis(fileEntries, ai).catch(
    (err) => {
      console.error(`[aiReview] complexity analysis failed: ${err.message}`);
      return [];
    }
  );
  const learningStatusPromise = categories
    ? fetchCohortSolvedProblems(repoOwner, repoName, prData.user.login, appToken)
        .then((solved) =>
          renderLearningStatus(prData.user.login, categories, solved)
        )
        .catch((err) => {
          console.error(`[aiReview] learning status failed: ${err.message}`);
          return null;
        })
    : Promise.resolve(null);

  // 파일별 패턴 + 의도한 접근 분석 (실패한 파일은 analysis 가 null)
  const analyses = [];
  for (const fe of fileEntries) {
    const problemInfo = categories?.[fe.problemName] ?? null;
    try {
      const analysis = await generatePatternAnalysis(
        fe.content,
        fe.problemName,
        problemInfo,
        ai
      );
      analyses.push({ fileEntry: fe, problemInfo, analysis });
    } catch (error) {
      console.error(
        `[aiReview] Failed to analyze ${fe.file.filename}: ${error.message}`
      );
      analyses.push({ fileEntry: fe, problemInfo, analysis: null });
    }
  }

  const [complexityResults, learningStatus] = await Promise.all([
    complexityPromise,
    learningStatusPromise,
  ]);

  const checkRun = await createCheckRun(
    repoOwner,
    repoName,
    headSha,
    renderCheckRunOutput(analyses, complexityResults, learningStatus),
    appToken
  );

  // 대화 탭의 링크 댓글 갱신 + 레거시 issue comment 삭제
  await syncIssueComments(
    repoOwner,
    repoName,
    prNumber,
    headSha,
    checkRun.html_url,
    appToken
  );

  return {
    analyzed: analyses.filter((a) => a.analysis !== null).length,
    checkRunUrl: checkRun.html_url,
  };
}

/**
 * check run output(title, summary, text)을 렌더링한다.
 * summary 에는 파일별 요약표와 학습 현황을, text 에는 파일별 상세 리뷰를 넣는다.
 *
 * @param {Array<{fileEntry: object, problemInfo: object|null, analysis: object|null}>} analyses
 * @param {Array<{problemName: string, solutions: Array}>} complexityResults
 * @param {string|null} learningStatus - 학습 현황 마크다운
 */
function renderCheckRunOutput(analyses, complexityResults, learningStatus) {
  const summaryLines = [
    "> 🤖 AI가 생성한 리뷰라 틀릴 수 있어요. 리뷰어의 피드백을 우선해 주세요.",
    "",
    "| 파일 | 난이도 | 패턴 | 의도한 접근 |",
    "|---|---|---|---|",
    ...analyses.map(
      ({ fileEntry, problemInfo, analysis }) =>
        `| \`${fileEntry.file.filename}\` | ${problemInfo?.difficulty ?? "-"} | ${renderPatterns(analysis)} | ${renderApproach(analysis)} |`
    ),
  ];
  if (learningStatus) {
    summaryLines.push("", learningStatus);
  }

  const text = analyses
    .map(({ fileEntry, problemInfo, analysis }) =>
      renderFileSection(
        fileEntry,
        problemInfo,
        analysis,
        complexityResults.find((r) => r.problemName === fileEntry.problemName)
      )
    )
    .join("\n\n");

  return {
    title: renderTitle(analyses),
    summary: truncateOutput(summaryLines.join("\n")),
    text: truncateOutput(text),
  };
}

function renderTitle(analyses) {
  const title = `풀이 ${analyses.length}개 리뷰`;
  const graded = analyses.filter((a) => a.analysis?.approach);
  if (graded.length === 0) return title;
  const matched = graded.filter((a) => a.analysis.approach.matches).length;
  return `${title} · 의도한 접근 ${matched}/${graded.length}`;
}

function renderPatterns(analysis) {
  if (analysis === null) return "⚠️ 분석 실패";
  return analysis.patterns.length > 0
    ? analysis.patterns.join(", ")
    : "감지된 패턴 없음";
}

function renderApproach(analysis) {
  if (!analysis?.approach) return "-";
  return analysis.approach.matches ? "✅ 일치" : "⚠️ 다름";
}

function renderFileSection(fileEntry, problemInfo, analysis, complexityForFile) {
  const lines = [`## \`${fileEntry.file.filename}\``, ""];

  if (fileEntry.isContentTruncated) {
    lines.push(
      `> ⚠️ 파일이 길어 앞부분 ${MAX_FILE_CONTENT_LENGTH}자만 분석했습니다.`,
      ""
    );
  }

  lines.push("### 🏷️ 알고리즘 패턴 분석", "");
  if (analysis === null) {
    lines.push("> ⚠️ 패턴 분석에 실패했습니다.");
  } else {
    lines.push(
      `- **패턴**: ${renderPatterns(analysis)}`,
      `- **설명**: ${analysis.description || "(설명 없음)"}`
    );
    if (analysis.approach) {
      lines.push(
        `- **의도한 접근** (${problemInfo.intended_approach}): ${renderApproach(analysis)}${analysis.approach.explanation ? ` — ${analysis.approach.explanation}` : ""}`
      );
    }
  }

  // 복잡도 섹션은 해당 파일 결과가 있을 때만 붙인다
  if (complexityForFile && complexityForFile.solutions.length > 0) {
    lines.push("", renderComplexitySection(complexityForFile));
  }

  return lines.join("\n");
}

function truncateOutput(value) {
  const notice = "\n\n... (이하 생략)";
  if (value.length <= MAX_CHECK_RUN_OUTPUT_LENGTH) return value;
  return value.slice(0, MAX_CHECK_RUN_OUTPUT_LENGTH - notice.length) + notice;
}

/**
 * PR head 커밋에 완료 상태의 check run 을 만든다.
 * conclusion 은 neutral 이라 statusCheckRollup 을 실패로 만들지 않는다.
 *
 * @see https://docs.github.com/en/rest/checks/runs#create-a-check-run
 */
async function createCheckRun(repoOwner, repoName, headSha, output, appToken) {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/check-runs`,
    {
      method: "POST",
      headers: {
        ...getGitHubHeaders(appToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: CHECK_RUN_NAME,
        head_sha: headSha,
        status: "completed",
        conclusion: "neutral",
        output,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create check run: ${response.status} ${errorText}`
    );
  }

  return response.json();
}

/**
 * 솔루션 파일들의 raw 내용을 한 번에 다운로드한다.
 * 패턴 분석과 복잡도 분석이 같은 fileEntries 를 공유한다.
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
          `[aiReview] Truncated ${file.filename} to ${MAX_FILE_CONTENT_LENGTH} chars`
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
 * issue comment 목록을 한 번 읽어 두 가지를 처리한다.
 *  - 링크 댓글: 봇이 단 것이 있으면 최신 check run 링크로 고치고, 없으면 새로 단다.
 *    분석 중에 새 커밋이 푸시됐다면 더 늦게 끝난 이전 분석이 최신 링크를 덮지 않도록 건너뛴다.
 *  - 레거시 issue comment(단독 복잡도 분석, 학습 현황): 있으면 삭제한다 (마이그레이션).
 * 실패해도 check run 은 이미 게시됐으므로 로그만 남긴다.
 */
async function syncIssueComments(
  repoOwner,
  repoName,
  prNumber,
  headSha,
  checkRunUrl,
  appToken
) {
  const comments = await listIssueComments(
    repoOwner,
    repoName,
    prNumber,
    appToken
  );
  if (comments === null) return;

  const findBotComment = (marker) =>
    comments.find((c) => c.user?.type === "Bot" && c.body?.includes(marker));

  const latestHeadSha = await getHeadSha(
    repoOwner,
    repoName,
    prNumber,
    appToken
  );
  if (latestHeadSha === headSha) {
    await upsertLinkComment(
      repoOwner,
      repoName,
      prNumber,
      findBotComment(LINK_COMMENT_MARKER),
      checkRunUrl,
      appToken
    );
  } else {
    console.log(
      `[aiReview] Skipping link comment on PR #${prNumber}: head moved from ${headSha} to ${latestHeadSha}`
    );
  }

  for (const marker of LEGACY_COMMENT_MARKERS) {
    const legacy = findBotComment(marker);
    if (legacy) {
      await deleteIssueComment(repoOwner, repoName, legacy.id, appToken);
    }
  }
}

/**
 * PR 의 issue comment 를 모든 페이지에 걸쳐 모은다. 실패하면 null.
 */
async function listIssueComments(repoOwner, repoName, prNumber, appToken) {
  const comments = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { headers: getGitHubHeaders(appToken) }
    );

    if (!response.ok) {
      console.error(
        `[aiReview] Failed to list issue comments: ${response.status}`
      );
      return null;
    }

    const batch = await response.json();
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

/**
 * PR 의 현재 head 커밋 SHA. 실패하면 null 이라 링크 댓글 갱신을 건너뛴다.
 */
async function getHeadSha(repoOwner, repoName, prNumber, appToken) {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
    { headers: getGitHubHeaders(appToken) }
  );

  if (!response.ok) {
    console.error(`[aiReview] Failed to get PR #${prNumber}: ${response.status}`);
    return null;
  }

  const pr = await response.json();
  return pr.head?.sha ?? null;
}

async function upsertLinkComment(
  repoOwner,
  repoName,
  prNumber,
  existing,
  checkRunUrl,
  appToken
) {
  const body = `${LINK_COMMENT_MARKER}
🤖 AI 리뷰(알고리즘 패턴, 시간/공간 복잡도, 학습 현황) 결과는 [Checks 탭](${checkRunUrl})에서 볼 수 있어요.`;

  const url = existing
    ? `https://api.github.com/repos/${repoOwner}/${repoName}/issues/comments/${existing.id}`
    : `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`;

  try {
    const response = await fetch(url, {
      method: existing ? "PATCH" : "POST",
      headers: {
        ...getGitHubHeaders(appToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });

    if (!response.ok) {
      console.error(
        `[aiReview] Failed to upsert link comment on PR #${prNumber}: ${response.status}`
      );
    }
  } catch (error) {
    console.error(
      `[aiReview] Error upserting link comment on PR #${prNumber}: ${error.message}`
    );
  }
}

async function deleteIssueComment(repoOwner, repoName, commentId, appToken) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/issues/comments/${commentId}`,
      {
        method: "DELETE",
        headers: getGitHubHeaders(appToken),
      }
    );

    if (!response.ok) {
      console.error(
        `[aiReview] Failed to delete legacy comment ${commentId}: ${response.status}`
      );
      return;
    }

    console.log(
      `[aiReview] Deleted legacy issue comment ${commentId}`
    );
  } catch (error) {
    console.error(
      `[aiReview] Error deleting legacy comment ${commentId}: ${error.message}`
    );
  }
}
