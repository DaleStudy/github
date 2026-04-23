/**
 * 시간/공간 복잡도 자동 분석.
 * PR opened/reopened/synchronize 시 호출된다.
 *
 * 모든 로직(상수, OpenAI 호출, 댓글 포맷, upsert)을 이 파일에 응집한다.
 */

import { getGitHubHeaders } from "../utils/github.js";
import { hasMaintenanceLabel } from "../utils/validation.js";

// ── 상수 ──────────────────────────────────────────

const SOLUTION_PATH_REGEX = /^[^/]+\/[^/]+\.[^.]+$/;
const COMPLEXITY_COMMENT_MARKER = "<!-- dalestudy-complexity-analysis -->";
const MAX_FILE_SIZE = 15000;
const MAX_TOTAL_SIZE = 60000;
const FILE_DELIMITER = "=====";

// ── OpenAI 호출 ───────────────────────────────────

const SYSTEM_PROMPT = `당신은 알고리즘 풀이의 시간/공간 복잡도를 분석하는 전문가입니다.

여러 문제의 솔루션 코드가 구분자(===== {문제명} =====)로 나뉘어 제공됩니다.
각 파일은 라인 번호 prefix "L{n}: "와 함께 전달됩니다. 주석 귀속 판단에 이 라인 번호를 활용하세요.
각 문제별로 독립적으로 분석하세요.

## 풀이(solution) 경계
하나의 문제 안에 같은 문제를 여러 가지 방식으로 푼 풀이가 포함될 수 있습니다.
풀이는 top-level 함수/메서드/클래스 선언 단위로 구분합니다. 선언이 시작된 라인을 "헤더 라인",
본문이 끝난 라인을 "종료 라인"이라 합니다.
- 언어별 헤더 예: JS의 \`function\`/\`const ... = (...) =>\`, Python의 \`def\`/\`class\`,
  Rust의 \`fn\`/\`impl { pub fn ... }\`, Go의 \`func\`, Java/Kotlin의 메서드 선언 등.
- 파일 상단부터 순서대로 풀이 1..N으로 번호를 붙입니다.
- 중첩 함수(inner helper)는 독립 풀이로 세지 않습니다.

## 주석 귀속 규칙 (엄격)
풀이 k의 시간/공간 복잡도 주석은 다음 두 영역에서만 찾습니다.

1) 헤더 바로 위 영역
   - 풀이 k의 헤더 라인 바로 윗줄부터 위로 올라가면서 **빈 줄을 만나면 즉시 중단**합니다.
   - 풀이 k-1이 존재한다면 풀이 k-1의 종료 라인을 넘어가지 않습니다 (k=1이면 파일 시작이 하한).
   - 즉, 풀이 k의 헤더에 "붙어 있는" 연속된 주석 블록만 대상입니다.

2) 본문 첫 라인 영역
   - 풀이 k의 헤더 다음 라인에 붙어 있는 연속된 주석 블록(예: Python docstring, 함수 첫 줄 \`// ...\`).

위 두 영역 밖의 주석은 풀이 k의 주석이 **아닙니다**. 다른 풀이의 영역을 절대 침범하지 마세요.

## 유효한 복잡도 주석의 정의
주석이 유효한 복잡도 주석으로 인정되려면 다음을 **모두** 만족해야 합니다.
1. Big-O 리터럴 포함: \`O(...)\`, \`Θ(...)\`, \`Ω(...)\`, \`o(...)\`, \`ω(...)\` 중 하나.
2. 시간/공간 중 어느 쪽인지를 가리키는 키워드와 같은 라인 또는 같은 주석 블록 안에 있을 것:
   시간복잡도 / 공간복잡도 / TC / SC / Time / Space / Complexity.
3. 시간/공간 중 어느 쪽을 말하는지 판별 가능.

언어별 주석 스타일(\`//\`, \`#\`, \`/* */\`, \`--\`, \`"""\`)과 한/영 혼합을 허용합니다.
예: \`// TC: O(n)\`, \`# 시간복잡도: O(n log n)\`, \`/* Space: O(1) */\`, \`// Time: O(n^2)\`.

판별 불가하거나 위 조건 중 하나라도 어긋나면 그 주석은 **무시**합니다.

## 부정 예시 (아래는 모두 "주석 없음"으로 처리)
- \`// brute force 풀이\` — 접근 방식 설명일 뿐, 복잡도 측정치 아님
- \`# 두 포인터 사용\` — 알고리즘 언급만
- \`// 목표: O(n)으로 만들기\` — 목표/희망이지 측정치 아님
- \`// 공간 O(1)만 써야 함 (문제 제약)\` — 문제 제약 언급
- 풀이와 동떨어진 파일 상단의 문제 설명 주석(풀이 귀속 영역 밖)

풀이 k에 유효한 주석이 하나도 없으면:
  hasUserAnnotation = false, userTime = null, userSpace = null, matches.time = false, matches.space = false.

## 멀티 풀이 예시 (요약)
입력:
L1: // TC: O(n^4)
L2: // SC: O(n)
L3: const findMin_math = (nums) => Math.min(...nums);
L4:
L5: // TC: O(n^3)
L6: // SC: O(1)
L7: const findMin_naive = (nums) => { /* ... */ };
L8:
L9: const findMin = (nums) => { /* ... */ };

출력(요약):
[
  { name: "findMin_math",  userTime: "O(n^4)", userSpace: "O(n)", hasUserAnnotation: true  },
  { name: "findMin_naive", userTime: "O(n^3)", userSpace: "O(1)", hasUserAnnotation: true  },
  { name: "findMin",       userTime: null,     userSpace: null,   hasUserAnnotation: false }
]

## 각 풀이에 대해 출력할 필드
1. name: 함수명 또는 식별 가능한 이름 (예: "twoSum_bruteForce", "Solution.maxArea").
2. description: 접근 방식 한 줄 설명 (예: "이진 탐색", "HashMap 활용").
3. actualTime, actualSpace: 코드의 실제 시간/공간 복잡도를 Big-O 표기로 계산.
4. hasUserAnnotation, userTime, userSpace: 위 "주석 귀속 규칙" + "유효한 복잡도 주석의 정의"에 따라 채웁니다.
   - 한쪽만 있으면 다른 쪽은 null.
5. matches.time / matches.space:
   - hasUserAnnotation=false면 둘 다 false.
   - 사용자 값이 있는 항목만 actual과 비교하여 일치 여부를 boolean으로 반환.
6. feedback (한국어 1-3문장):
   - 일치하면: 칭찬 + 핵심 근거 짧게.
   - 불일치하면: 어디가 왜 다른지 설명 + "다시 분석해보시는 것을 권장드립니다" 톤.
   - 주석이 없으면: 풀이 핵심 근거만 설명.
7. suggestion (한국어, 항상 string):
   - 의미 있는 한 단계 이상 개선 여지가 있을 때만 제안 (예: O(n^2) → O(n)).
   - 문제 제약을 모를 수 있으므로 단정 금지. "고려해볼 만한 대안:" 톤.
   - 개선 여지 없으면 "현재 구현이 적절해 보입니다."

반드시 아래 JSON 스키마로만 응답:
{
  "files": [
    {
      "problemName": string,
      "solutions": [
        {
          "name": string,
          "description": string,
          "hasUserAnnotation": boolean,
          "userTime": string|null,
          "userSpace": string|null,
          "actualTime": string,
          "actualSpace": string,
          "matches": { "time": boolean, "space": boolean },
          "feedback": string,
          "suggestion": string
        }
      ]
    }
  ]
}`;

function addLineNumbers(content) {
  return content
    .split("\n")
    .map((line, i) => `L${i + 1}: ${line}`)
    .join("\n");
}

const BIG_O_PATTERN = /[OΘΩoω]\s*\(/;

function normalizeSolution(s) {
  const userTime =
    typeof s.userTime === "string" && BIG_O_PATTERN.test(s.userTime)
      ? s.userTime
      : null;
  const userSpace =
    typeof s.userSpace === "string" && BIG_O_PATTERN.test(s.userSpace)
      ? s.userSpace
      : null;

  const hasUserAnnotation = userTime !== null || userSpace !== null;

  return {
    name: typeof s.name === "string" ? s.name : "unknown",
    description: typeof s.description === "string" ? s.description : "",
    hasUserAnnotation,
    userTime,
    userSpace,
    actualTime: typeof s.actualTime === "string" ? s.actualTime : "?",
    actualSpace: typeof s.actualSpace === "string" ? s.actualSpace : "?",
    matches: {
      time:
        hasUserAnnotation && userTime !== null && s.matches?.time === true,
      space:
        hasUserAnnotation && userSpace !== null && s.matches?.space === true,
    },
    feedback: typeof s.feedback === "string" ? s.feedback : "",
    suggestion: typeof s.suggestion === "string" ? s.suggestion : "",
  };
}

async function callComplexityAnalysis(fileEntries, apiKey) {
  const userPrompt = fileEntries
    .map(
      (f) =>
        `${FILE_DELIMITER} ${f.problemName} ${FILE_DELIMITER}\n\`\`\`\n${addLineNumbers(f.content)}\n\`\`\``
    )
    .join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${content.slice(0, 200)}`);
  }

  const files = Array.isArray(parsed.files) ? parsed.files : [];

  return files.map((file) => ({
    problemName:
      typeof file.problemName === "string" ? file.problemName : "unknown",
    solutions: (Array.isArray(file.solutions) ? file.solutions : []).map(
      normalizeSolution
    ),
  }));
}

// ── 댓글 포맷터 ──────────────────────────────────

function buildSummaryResult(solution) {
  if (!solution.hasUserAnnotation) {
    return `Time: ${solution.actualTime} / Space: ${solution.actualSpace}`;
  }
  const timePart = solution.userTime
    ? `Time: ${solution.matches.time ? "✅" : "❌"} ${solution.userTime} → ${solution.actualTime}`
    : `Time: ${solution.actualTime}`;
  const spacePart = solution.userSpace
    ? `Space: ${solution.matches.space ? "✅" : "❌"} ${solution.userSpace} → ${solution.actualSpace}`
    : `Space: ${solution.actualSpace}`;
  return `${timePart} / ${spacePart}`;
}

function buildSolutionBody(solution) {
  const lines = [];

  if (solution.hasUserAnnotation) {
    const timeMark = solution.matches.time ? "✅" : "❌";
    const spaceMark = solution.matches.space ? "✅" : "❌";
    lines.push("| | 유저 분석 | 실제 분석 | 결과 |");
    lines.push("|---|---|---|---|");
    lines.push(
      `| **Time** | ${solution.userTime ?? "-"} | ${solution.actualTime} | ${solution.userTime ? timeMark : "-"} |`
    );
    lines.push(
      `| **Space** | ${solution.userSpace ?? "-"} | ${solution.actualSpace} | ${solution.userSpace ? spaceMark : "-"} |`
    );
  } else {
    lines.push("| | 복잡도 |");
    lines.push("|---|---|");
    lines.push(`| **Time** | ${solution.actualTime} |`);
    lines.push(`| **Space** | ${solution.actualSpace} |`);
  }

  lines.push("");
  if (solution.feedback) {
    lines.push(`**피드백**: ${solution.feedback}`);
    lines.push("");
  }
  if (solution.suggestion) {
    lines.push(`**개선 제안**: ${solution.suggestion}`);
    lines.push("");
  }

  return lines;
}

function formatComplexityCommentBody(entries) {
  const lines = [];
  lines.push(COMPLEXITY_COMMENT_MARKER);
  lines.push("### 📊 시간/공간 복잡도 분석");
  lines.push("");

  for (const { problemName, solutions } of entries) {
    lines.push(`### ${problemName}`);
    lines.push("");

    if (!solutions || solutions.length === 0) {
      lines.push(`> ⚠️ 분석 결과가 없습니다.`);
      lines.push("");
      continue;
    }

    const isMulti = solutions.length > 1;
    const hasAnyAnnotationMissing = solutions.some(
      (s) => !s.hasUserAnnotation
    );

    if (isMulti) {
      lines.push(
        `> ℹ️ 이 파일에는 **${solutions.length}가지 풀이**가 포함되어 있어 각각 분석합니다.`
      );
      lines.push("");

      solutions.forEach((sol, idx) => {
        const summaryResult = buildSummaryResult(sol);
        lines.push(`<details>`);
        lines.push(
          `<summary>풀이 ${idx + 1}: <code>${sol.name}</code> — ${summaryResult}</summary>`
        );
        lines.push("");
        lines.push(...buildSolutionBody(sol));
        lines.push(`</details>`);
        lines.push("");
      });
    } else {
      lines.push(...buildSolutionBody(solutions[0]));
    }

    if (hasAnyAnnotationMissing) {
      lines.push("> 💡 풀이에 시간/공간 복잡도를 주석으로 남겨보세요!");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("🤖 이 댓글은 GitHub App을 통해 자동으로 작성되었습니다.");

  return lines.join("\n") + "\n";
}

// ── 댓글 upsert ──────────────────────────────────

async function upsertComplexityComment(
  repoOwner,
  repoName,
  prNumber,
  body,
  appToken
) {
  const baseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}`;

  const listResponse = await fetch(
    `${baseUrl}/issues/${prNumber}/comments?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );
  if (!listResponse.ok) {
    throw new Error(
      `Failed to list comments: ${listResponse.status} ${listResponse.statusText}`
    );
  }

  const comments = await listResponse.json();
  const existing = comments.find(
    (c) =>
      c.user?.type === "Bot" &&
      c.body?.includes(COMPLEXITY_COMMENT_MARKER)
  );

  const headers = {
    ...getGitHubHeaders(appToken),
    "Content-Type": "application/json",
  };

  if (existing) {
    const res = await fetch(`${baseUrl}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to update complexity comment ${existing.id}: ${res.status}`
      );
    }
    console.log(
      `[complexity] Updated comment ${existing.id} on PR #${prNumber}`
    );
  } else {
    const res = await fetch(`${baseUrl}/issues/${prNumber}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      throw new Error(`Failed to post complexity comment: ${res.status}`);
    }
    console.log(`[complexity] Created complexity comment on PR #${prNumber}`);
  }
}

// ── 오케스트레이션 (export) ───────────────────────

export async function analyzeComplexity(
  repoOwner,
  repoName,
  prNumber,
  prData,
  appToken,
  openaiApiKey
) {
  if (prData.draft === true) {
    console.log(`[complexity] Skipping PR #${prNumber}: draft`);
    return { skipped: "draft" };
  }
  const labels = (prData.labels || []).map((l) => l.name);
  if (hasMaintenanceLabel(labels)) {
    console.log(`[complexity] Skipping PR #${prNumber}: maintenance`);
    return { skipped: "maintenance" };
  }

  // 1) PR files
  const filesRes = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}/files?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );
  if (!filesRes.ok) {
    throw new Error(
      `Failed to list PR files: ${filesRes.status} ${filesRes.statusText}`
    );
  }
  const allFiles = await filesRes.json();

  const solutionFiles = allFiles.filter(
    (f) =>
      (f.status === "added" || f.status === "modified") &&
      SOLUTION_PATH_REGEX.test(f.filename)
  );

  console.log(
    `[complexity] PR #${prNumber}: ${allFiles.length} files, ${solutionFiles.length} solutions`
  );

  if (solutionFiles.length === 0) {
    return { skipped: "no-solution-files" };
  }

  // 2) 모든 솔루션 파일 다운로드
  const fileEntries = [];
  let totalSize = 0;

  for (const file of solutionFiles) {
    const problemName = file.filename.split("/")[0];
    try {
      const rawRes = await fetch(file.raw_url);
      if (!rawRes.ok) {
        console.error(
          `[complexity] Failed to fetch ${file.filename}: ${rawRes.status}`
        );
        continue;
      }
      let content = await rawRes.text();
      if (content.length > MAX_FILE_SIZE) {
        content = content.slice(0, MAX_FILE_SIZE);
      }

      if (totalSize + content.length > MAX_TOTAL_SIZE) {
        console.log(
          `[complexity] Reached MAX_TOTAL_SIZE, skipping remaining files`
        );
        break;
      }

      totalSize += content.length;
      fileEntries.push({ problemName, content });
    } catch (error) {
      console.error(
        `[complexity] Failed to download ${file.filename}: ${error.message}`
      );
    }
  }

  if (fileEntries.length === 0) {
    return { skipped: "all-downloads-failed" };
  }

  // 3) OpenAI 1회 호출로 모든 파일 분석
  const analysisResults = await callComplexityAnalysis(
    fileEntries,
    openaiApiKey
  );

  // 4) 결과를 fileEntries 순서에 맞춰 매핑
  const entries = fileEntries.map((fe) => {
    const match = analysisResults.find(
      (r) => r.problemName === fe.problemName
    );
    return match || { problemName: fe.problemName, solutions: [] };
  });

  // 5) 본문 빌드 + upsert
  const body = formatComplexityCommentBody(entries);
  await upsertComplexityComment(repoOwner, repoName, prNumber, body, appToken);

  return {
    analyzed: entries.filter((e) => e.solutions.length > 0).length,
    total: fileEntries.length,
  };
}
