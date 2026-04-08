/**
 * 학습 현황 오케스트레이션 핸들러
 *
 * PR 제출 파일들을 AI로 분석하여 사용자의 누적 학습 현황을
 * PR 이슈 댓글로 게시하거나 업데이트한다.
 */

import {
  fetchProblemCategories,
  fetchUserSolutions,
  fetchPRSubmissions,
} from "../utils/learningData.js";
import { generateApproachAnalysis } from "../utils/openai.js";
import {
  formatLearningStatusComment,
  upsertLearningStatusComment,
} from "../utils/learningComment.js";

const MAX_FILE_SIZE = 15000; // 15K 문자 제한 (OpenAI 토큰 안전장치)

/**
 * 카테고리별로 누적 풀이 진행도를 계산한다.
 *
 * @param {object} categories - problem-categories.json 전체 오브젝트
 * @param {string[]} solvedProblems - 사용자가 풀이한 문제 이름 배열
 * @returns {Array<{ category: string, solved: number, total: number, difficulties: string }>}
 */
function buildCategoryProgress(categories, solvedProblems) {
  const solvedSet = new Set(solvedProblems);
  const categoryMap = new Map();

  for (const [problemName, info] of Object.entries(categories)) {
    for (const cat of info.categories) {
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, { total: 0, solved: 0, solvedDifficulties: [] });
      }
      const entry = categoryMap.get(cat);
      entry.total++;
      if (solvedSet.has(problemName)) {
        entry.solved++;
        entry.solvedDifficulties.push(info.difficulty);
      }
    }
  }

  return [...categoryMap.entries()]
    .sort((a, b) => {
      const ratioA = a[1].total > 0 ? a[1].solved / a[1].total : 0;
      const ratioB = b[1].total > 0 ? b[1].solved / b[1].total : 0;
      if (ratioB !== ratioA) return ratioB - ratioA;
      return a[0].localeCompare(b[0]);
    })
    .map(([cat, data]) => {
      const diffCounts = {};
      for (const d of data.solvedDifficulties) {
        diffCounts[d] = (diffCounts[d] || 0) + 1;
      }
      const difficulties = Object.entries(diffCounts)
        .map(([d, c]) => `${d} ${c}`)
        .join(", ");
      return { category: cat, solved: data.solved, total: data.total, difficulties };
    });
}

/**
 * 학습 현황 기능 전체 흐름 오케스트레이션
 *
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} username
 * @param {string} appToken - GitHub App installation token
 * @param {string} openaiApiKey
 * @returns {Promise<{ skipped: string }|{ analyzed: number, matched: number }>}
 */
export async function postLearningStatus(
  repoOwner,
  repoName,
  prNumber,
  username,
  appToken,
  openaiApiKey
) {
  // 1. 문제 카테고리 메타데이터 조회
  const categories = await fetchProblemCategories(repoOwner, repoName, appToken);
  if (!categories) {
    console.log(`[learningStatus] PR #${prNumber}: problem-categories.json not found, skipping`);
    return { skipped: "no-categories-file" };
  }

  // 2. 사용자의 누적 풀이 목록 조회
  const solvedProblems = await fetchUserSolutions(repoOwner, repoName, username, appToken);
  console.log(
    `[learningStatus] PR #${prNumber}: ${username} has ${solvedProblems.length} cumulative solutions`
  );

  // 3. 이번 PR 제출 파일 목록 조회
  const submissions = await fetchPRSubmissions(repoOwner, repoName, prNumber, username, appToken);
  if (submissions.length === 0) {
    console.log(`[learningStatus] PR #${prNumber}: no solution files found for ${username}, skipping`);
    return { skipped: "no-solution-files" };
  }

  console.log(
    `[learningStatus] PR #${prNumber}: analyzing ${submissions.length} submission(s) for ${username}`
  );

  // 4. 제출 파일별 AI 분석
  const submissionResults = [];
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

  for (const submission of submissions) {
    const problemInfo = categories[submission.problemName];

    if (!problemInfo) {
      console.log(
        `[learningStatus] No category info for "${submission.problemName}", skipping AI analysis`
      );
      submissionResults.push({
        problemName: submission.problemName,
        difficulty: null,
        matches: null,
        explanation: "",
      });
      continue;
    }

    try {
      // 파일 원본 내용 가져오기
      const rawResponse = await fetch(submission.rawUrl);
      if (!rawResponse.ok) {
        throw new Error(`Failed to fetch raw file: ${rawResponse.status} ${rawResponse.statusText}`);
      }

      let fileContent = await rawResponse.text();
      if (fileContent.length > MAX_FILE_SIZE) {
        fileContent = fileContent.slice(0, MAX_FILE_SIZE);
        console.log(
          `[learningStatus] Truncated "${submission.problemName}" to ${MAX_FILE_SIZE} chars`
        );
      }

      const analysis = await generateApproachAnalysis(
        fileContent,
        submission.problemName,
        problemInfo,
        openaiApiKey
      );

      if (analysis.usage) {
        totalUsage.prompt_tokens += analysis.usage.prompt_tokens ?? 0;
        totalUsage.completion_tokens += analysis.usage.completion_tokens ?? 0;
      }

      submissionResults.push({
        problemName: submission.problemName,
        difficulty: problemInfo.difficulty,
        matches: analysis.matches,
        explanation: analysis.explanation,
      });
    } catch (error) {
      console.error(
        `[learningStatus] Failed to analyze "${submission.problemName}": ${error.message}`
      );
      submissionResults.push({
        problemName: submission.problemName,
        difficulty: problemInfo.difficulty,
        matches: null,
        explanation: "",
      });
    }
  }

  const hasUsage = totalUsage.prompt_tokens > 0 || totalUsage.completion_tokens > 0;

  // 5. 카테고리별 진행도 계산
  const totalProblems = Object.keys(categories).length;
  const categoryProgress = buildCategoryProgress(categories, solvedProblems);

  // 6. 댓글 본문 포맷
  const commentBody = formatLearningStatusComment(
    username,
    submissionResults,
    solvedProblems.length,
    totalProblems,
    categoryProgress
  );

  // 7. 댓글 생성 또는 업데이트
  await upsertLearningStatusComment(
    repoOwner,
    repoName,
    prNumber,
    commentBody,
    appToken,
    hasUsage ? totalUsage : null
  );

  // 8. 결과 반환
  const matchedCount = submissionResults.filter((r) => r.matches === true).length;
  return { analyzed: submissionResults.length, matched: matchedCount };
}
