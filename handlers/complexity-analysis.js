/**
 * 시간/공간 복잡도 자동 분석.
 * PR opened/reopened/synchronize 시 호출된다.
 *
 * 책임 분담 (plan v4):
 *  - 코드: 사용자 복잡도 주석 제거 / 추출 / matches 판정.
 *  - LLM : actualTime / actualSpace / feedback / suggestion / headerLine 만 책임.
 */

import { getGitHubHeaders } from "../utils/github.js";
import { hasMaintenanceLabel } from "../utils/validation.js";

// ── 상수 ──────────────────────────────────────────

const SOLUTION_PATH_REGEX = /^[^/]+\/[^/]+\.[^.]+$/;
const COMPLEXITY_COMMENT_MARKER = "<!-- dalestudy-complexity-analysis -->";
const MAX_FILE_SIZE = 15000;
const MAX_TOTAL_SIZE = 60000;
const FILE_DELIMITER = "=====";

const COMMENT_START_PATTERN = /^(?:\/\/|#|--|;|\/\*|\*(?!\/)|"""|''')/;
const TIME_KEYWORD_PATTERN =
  /\b(?:TC|tc|Time|time)\b|시간\s*복잡도/;
const SPACE_KEYWORD_PATTERN =
  /\b(?:SC|sc|Space|space)\b|공간\s*복잡도/;
const BIG_O_LITERAL_PATTERN = /[OΘΩoω]\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/;

// "class Solution:" / "public class Foo {" / "impl X for Y {" 등 — 메서드 헤더의
// 외곽 선언. 사용자 복잡도 주석은 보통 이 외곽 선언 위에 적힌다.
const CLASS_WRAPPER_PATTERN =
  /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|export\s+(?:default\s+)?|pub\s+)*(?:class|interface|struct|trait|impl|enum)\b[^{]*[:{]\s*$/;

// ── 사용자 복잡도 주석 처리 (코드 책임) ──────────

export function isComplexityCommentLine(line) {
  if (typeof line !== "string") return false;
  const trimmed = line.trim();
  if (!COMMENT_START_PATTERN.test(trimmed)) return false;
  const hasKeyword =
    TIME_KEYWORD_PATTERN.test(line) || SPACE_KEYWORD_PATTERN.test(line);
  const hasBigO = BIG_O_LITERAL_PATTERN.test(line);
  return hasKeyword && hasBigO;
}

export function stripComplexityComments(content) {
  return content
    .split("\n")
    .map((line) => (isComplexityCommentLine(line) ? "" : line))
    .join("\n");
}

export function extractBigO(line) {
  const m = line.match(BIG_O_LITERAL_PATTERN);
  return m ? m[0] : null;
}

function isCommentLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  return COMMENT_START_PATTERN.test(trimmed) || trimmed.startsWith("*/");
}

function isClassWrapperLine(line) {
  return typeof line === "string" && CLASS_WRAPPER_PATTERN.test(line);
}

/**
 * 헤더 라인 위쪽으로 빈 줄 또는 비-주석 라인을 만나기 전까지의 연속 주석 블록에서
 * 시간/공간 복잡도 주석을 추출한다.
 *
 * 단, 외곽 클래스/struct/impl 선언 라인(예: `class Solution:`)은 투명하게 통과한다.
 * Python LeetCode 풀이처럼 사용자 주석이 클래스 선언 위에 있고, 모델이 메서드 라인을
 * headerLine 으로 반환하는 흔한 패턴을 지원하기 위함.
 */
export function extractUserAnnotations(content, headerLine) {
  if (!Number.isInteger(headerLine) || headerLine <= 1) {
    return { userTime: null, userSpace: null };
  }
  const lines = content.split("\n");
  let userTime = null;
  let userSpace = null;
  for (let i = headerLine - 2; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "") break;

    if (isClassWrapperLine(line)) {
      continue; // 외곽 클래스 선언은 투명 통과
    }

    if (!isCommentLine(line)) break;

    if (userTime === null && TIME_KEYWORD_PATTERN.test(line)) {
      const bigO = extractBigO(line);
      if (bigO) userTime = bigO;
    }
    if (userSpace === null && SPACE_KEYWORD_PATTERN.test(line)) {
      const bigO = extractBigO(line);
      if (bigO) userSpace = bigO;
    }
    if (userTime !== null && userSpace !== null) break;
  }
  return { userTime, userSpace };
}

/**
 * 모델이 actualTime/actualSpace 에 부연 설명을 붙이는 글리치를 정리한다.
 * 예: "O(n) (최악)" → "O(n)", "O(m * 26^{k}) (최악: ...)" → "O(m * 26^{k})".
 * 첫 번째 균형 맞춘 Big-O 리터럴만 남긴다.
 */
export function cleanBigO(value) {
  if (typeof value !== "string") return value;
  const m = value.match(BIG_O_LITERAL_PATTERN);
  return m ? m[0] : value;
}

export function bigOEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (s) =>
    s
      .replace(/\s+/g, "")
      .replace(/²/g, "^2")
      .replace(/³/g, "^3")
      .replace(/⁴/g, "^4")
      .replace(/⁵/g, "^5")
      .replace(/⁶/g, "^6")
      .replace(/⁷/g, "^7")
      .replace(/⁸/g, "^8")
      .replace(/⁹/g, "^9")
      .replace(/\*\*/g, "^")
      .toLowerCase();
  return norm(a) === norm(b);
}

// ── OpenAI 호출 ───────────────────────────────────

const SYSTEM_PROMPT = `당신은 알고리즘 풀이의 시간/공간 복잡도를 분석하는 전문가입니다.

# 입력
"===== 문제명 =====" 구분자로 여러 파일이 제공됩니다.
각 라인에 "L{n}: " 라인 번호 prefix 가 붙어 있습니다.

전달되는 코드에서 **사용자가 작성한 시간/공간 복잡도 주석은 이미 자동 제거**되어 있습니다.
즉 코드에 어떤 주석이 남아 있든 거기엔 복잡도 주장이 없습니다.
당신은 **코드의 동작만으로** 실제 복잡도를 판정하면 됩니다.
사용자의 시간/공간 분석값은 다른 시스템이 별도로 추출하므로 신경 쓰지 않아도 됩니다.

# 풀이(solution) 구분
한 파일에 여러 풀이가 있을 수 있습니다. 풀이는 top-level 함수/메서드/클래스 선언 단위로 셉니다.
중첩 함수/inner helper 는 독립 풀이로 세지 않습니다.

# 각 풀이마다 결정할 7개 값

1. **name** — 함수명 또는 "클래스.메서드" 형식. 예: "twoSum", "Solution.maxArea", "WordDictionary.addWord".
   주석 텍스트나 한국어 문구를 절대 name 으로 사용하지 마세요.
2. **headerLine** — 풀이 헤더가 시작되는 라인 번호 (정수).
   예: \`function twoSum(...) {\` 가 L7 이면 7. \`class Solution:\` 만으로 시작하면 그 라인.
   클래스 안에 메서드가 하나라도 메서드 라인 또는 클래스 라인 어느 쪽이든 무방
   (외곽 클래스 선언은 추출 시 투명 통과 처리됨).
   JSDoc/docstring/주석 라인은 헤더가 아닙니다 — 실제 코드 선언 라인을 가리키세요.
3. **description** — 알고리즘/접근 방식 한 줄 요약 (한국어).
4. **actualTime** — 코드 동작 기준 실제 시간 복잡도. **순수 Big-O 표기만**.
   예: "O(n)", "O(n log n)", "O(n^2)", "O(n + m)", "O(V + E)".
   부연 설명/한국어/괄호 코멘트 금지. 예시 금지: "O(n) (최악)", "O(n) for n nodes".
5. **actualSpace** — 코드 동작 기준 실제 공간 복잡도. 같은 규칙 적용.
6. **feedback** — 한국어 1~2 문장. 어떤 자료구조/알고리즘을 사용했고 왜 그 복잡도가 나오는지 짧게 설명.
   "matches" 나 "사용자" 같은 메타 표현은 사용하지 마세요. 사용자에게 직접 보여지는 문장입니다.
7. **suggestion** — 한국어. 한 단계 이상 의미 있는 개선 여지(예: O(n^2)→O(n))가 있을 때만
   "고려해볼 만한 대안: ..." 톤으로 제안. 없으면 "현재 구현이 적절해 보입니다.".

# Big-O 표기 규칙
- 거듭제곱은 \`^\` 사용 (가능하면 O(n^2). O(n²) 도 허용).
- log 는 공백/곱셈 기호 자유: \`O(n log n)\`, \`O(n*log n)\`, \`O(nlogn)\` 모두 같음.
- 두 변수: \`O(n + m)\`, \`O(n*m)\`, \`O(V + E)\`.

# problemName
입력의 \`===== {이름} =====\` 구분자에 적힌 문자열을 **글자 그대로** problemName 에 복사하세요.
줄여 쓰거나(longest-... → long-...), 단어를 빼거나, 단수/복수 변형을 가하지 마세요.

# 출력
다음 JSON 만 응답. 다른 텍스트/마크다운/설명 일체 금지:

{
  "files": [
    {
      "problemName": "string",
      "solutions": [
        {
          "name": "string",
          "headerLine": integer,
          "description": "string",
          "actualTime": "string",
          "actualSpace": "string",
          "feedback": "string",
          "suggestion": "string"
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

export function composeSolution(modelSol, originalContent) {
  const headerLine = Number.isInteger(modelSol?.headerLine)
    ? modelSol.headerLine
    : null;
  const { userTime, userSpace } =
    headerLine !== null
      ? extractUserAnnotations(originalContent, headerLine)
      : { userTime: null, userSpace: null };

  const hasUserAnnotation = userTime !== null || userSpace !== null;
  const actualTime =
    typeof modelSol?.actualTime === "string"
      ? cleanBigO(modelSol.actualTime)
      : "?";
  const actualSpace =
    typeof modelSol?.actualSpace === "string"
      ? cleanBigO(modelSol.actualSpace)
      : "?";

  return {
    name: typeof modelSol?.name === "string" ? modelSol.name : "unknown",
    description:
      typeof modelSol?.description === "string" ? modelSol.description : "",
    hasUserAnnotation,
    userTime,
    userSpace,
    actualTime,
    actualSpace,
    matches: {
      time: userTime !== null && bigOEquals(userTime, actualTime),
      space: userSpace !== null && bigOEquals(userSpace, actualSpace),
    },
    feedback: typeof modelSol?.feedback === "string" ? modelSol.feedback : "",
    suggestion:
      typeof modelSol?.suggestion === "string" ? modelSol.suggestion : "",
  };
}

async function callComplexityAnalysis(fileEntries, apiKey) {
  const userPrompt = fileEntries
    .map(
      (f) =>
        `${FILE_DELIMITER} ${f.problemName} ${FILE_DELIMITER}\n\`\`\`\n${addLineNumbers(stripComplexityComments(f.content))}\n\`\`\``
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

  return files.map((file, fileIdx) => {
    const modelName =
      typeof file.problemName === "string" ? file.problemName : "unknown";
    // 모델이 problemName 을 줄여 쓰는 버그 (예: longest-... → long-...) 가 있으므로
    // 정확 일치가 없으면 인덱스로 폴백한다 (LLM 이 입력 순서를 보존한다는 가정).
    const original =
      fileEntries.find((f) => f.problemName === modelName) ??
      fileEntries[fileIdx];
    const problemName = original?.problemName ?? modelName;
    const originalContent = original?.content ?? "";
    return {
      problemName,
      solutions: (Array.isArray(file.solutions) ? file.solutions : []).map(
        (s) => composeSolution(s, originalContent)
      ),
    };
  });
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
