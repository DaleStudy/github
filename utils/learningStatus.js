/**
 * AI 리뷰 check run 의 학습 현황 섹션
 */

// Blind Top 75 큐레이션 순서 — 동률 정렬의 타이브레이커로 사용.
// 출처: https://www.teamblind.com/post/new-year-gift-curated-list-of-top-75-leetcode-questions-to-save-your-time-oam1oreu
const BLIND_CATEGORY_ORDER = [
  "Array",
  "Binary",
  "Dynamic Programming",
  "Graph",
  "Interval",
  "Linked List",
  "Matrix",
  "String",
  "Tree",
  "Heap",
];

/**
 * Blind Top 75 카테고리별 누적 풀이 진행도.
 * problem-categories.json 의 blindCategories 를 기준으로 Blind 10개 카테고리만 집계한다.
 *
 * @param {object} categories - problem-categories.json 전체 오브젝트
 * @param {string[]} solvedProblems - 사용자가 푼 문제 이름 배열
 * @returns {Array<{ category: string, solved: number, total: number, difficulties: string }>}
 */
export function buildCategoryProgress(categories, solvedProblems) {
  const solvedSet = new Set(solvedProblems);
  const categoryMap = new Map(
    BLIND_CATEGORY_ORDER.map((cat) => [
      cat,
      { total: 0, solved: 0, solvedDifficulties: [] },
    ])
  );

  for (const [problemName, info] of Object.entries(categories)) {
    for (const cat of info.blindCategories) {
      const entry = categoryMap.get(cat);
      if (!entry) continue;
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
      return (
        BLIND_CATEGORY_ORDER.indexOf(a[0]) - BLIND_CATEGORY_ORDER.indexOf(b[0])
      );
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
 * @param {number} completed
 * @param {number} total
 * @param {number} [barLength=7]
 * @returns {string}  e.g. "■■■□□□□"
 */
function progressBar(completed, total, barLength = 7) {
  if (total === 0) {
    return "□".repeat(barLength);
  }
  const filled = Math.min(Math.round((completed / total) * barLength), barLength);
  return "■".repeat(filled) + "□".repeat(barLength - filled);
}

/**
 * 학습 현황 마크다운 섹션.
 *
 * @param {string} username
 * @param {object} categories - problem-categories.json 전체 오브젝트
 * @param {string[]} cohortSolutions - 이번 기수에 머지된 PR 에서 푼 문제 이름 배열
 * @returns {string}
 */
export function renderLearningStatus(username, categories, cohortSolutions) {
  const solvedProblems = cohortSolutions.filter((name) =>
    Object.hasOwn(categories, name)
  );
  const totalProblems = Object.keys(categories).length;

  const lines = [
    `## 📊 ${username} 님의 학습 현황`,
    "",
    `이번 기수에 푼 문제: ${solvedProblems.length} / ${totalProblems}개 (머지된 PR 기준)`,
    "",
    "| 카테고리 | 진행도 | 완료 |",
    "|---|---|---|",
  ];

  for (const { category, solved, total, difficulties } of buildCategoryProgress(
    categories,
    solvedProblems
  )) {
    const completion = difficulties
      ? `${solved} / ${total} (${difficulties})`
      : `${solved} / ${total}`;
    lines.push(`| ${category} | ${progressBar(solved, total)} | ${completion} |`);
  }

  return lines.join("\n");
}
