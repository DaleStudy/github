# 시간/공간 복잡도 자동 분석 — 구현 계획

연관 이슈: [DaleStudy/github#8](https://github.com/DaleStudy/github/issues/8)
참고: [research.md](research.md) (단, §7 항목들은 본 작업 범위 외로 두고 건드리지 않음)

---

## 1. 목표 & 스코프

PR `opened` / `reopened` / `synchronize` 시, 솔루션 파일들의 시간/공간 복잡도를 OpenAI로 분석하여 **PR에 단 하나의 issue 댓글**(upsert)을 작성한다. 댓글에는 PR에 포함된 모든 솔루션 파일이 섹션별로 누적된다.

처리 케이스:

**단일 풀이**
- **케이스 1**: 사용자가 TC/SC 주석을 달았고 분석 결과와 일치 → ✅ 비교 표
- **케이스 2**: 사용자 주석이 있지만 불일치 → ❌ 비교 표 + 다시 풀이 권장 톤 피드백
- **케이스 3**: 사용자 주석 없음 → 분석 결과만 + 주석 작성 권장 안내

**멀티 풀이** (하나의 솔루션 파일에 여러 접근법이 포함된 경우)
- **케이스 4**: 멀티 풀이 + 유저 주석 있음 → 풀이별 `<details>` 접기, summary에 결과(✅/❌) 표시
- **케이스 5**: 멀티 풀이 + 유저 주석 없음 → 풀이별 `<details>` 접기, summary에 복잡도 표시

---

## 2. 아키텍처 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 진입점 | [handlers/webhooks.js](handlers/webhooks.js) `handlePullRequestEvent` 안에 등록 | 패턴 태깅/학습 현황과 동일한 위치 |
| 파일 구조 | **`handlers/complexity-analysis.js` 단일 파일** | 상수, OpenAI 호출, 댓글 포맷터, upsert 모두 한 파일에 응집. 다른 기능 파일에 영향 없음 |
| 댓글 종류 | **PR issue comment** (review comment 아님) | 솔루션이 여러 개여도 한 댓글에 합쳐서 보여줘야 하므로 |
| 댓글 식별 | HTML 마커 `<!-- dalestudy-complexity-analysis -->` | learningComment.js 와 동일 패턴 |
| 작성 방식 | upsert (있으면 PATCH, 없으면 POST) | learningComment.js 의 `upsertLearningStatusComment` 와 동일 패턴 |
| OpenAI 호출 | **모든 솔루션 파일을 구분자로 합쳐 1회 호출** | 파일별 호출 대비 API 비용/latency 대폭 절감. Workers timeout 위험도 줄어듦 |
| OpenAI 모델 | `gpt-4.1-nano`, `response_format: json_object`, `temperature: 0.2` | openai.js 의 다른 분석 함수들과 동일 |
| webhooks 통합 | 기존 try/catch 패턴과 동일하게 추가 | 다른 기능 소스코드에 영향 없음 |
| Non-blocking | 핸들러 자체가 throw 안 함, 실패는 console.error만 | 기존 패턴 동일 |
| 주석 파싱 | OpenAI에게 위임 | 자유 포맷 + 다국어 + 다언어. 정규식으로는 신뢰성 낮음 |
| 멀티 풀이 감지 | OpenAI에게 위임 | 언어/구조가 다양해 정규식으로 함수 경계를 잡기 어려움 |
| 멀티 풀이 포맷 | `<details>` 접기 + summary에 결과 표시 | 댓글 길이 관리 + 접힌 상태에서도 핵심 정보 확인 가능 |

> **단일 파일 구조의 이유**: 이 기능은 자체적으로 완결된 기능이고, 다른 핸들러와 공유할 유틸이 없다. `utils/` 에 분산시키면 오히려 코드 추적이 어려워지고, 다른 팀의 파일(`constants.js`, `openai.js`)에 변경이 생긴다. 한 파일에 모아두면 기능 전체를 한눈에 파악할 수 있고, 삭제/수정 시에도 한 곳만 건드리면 된다.

> **OpenAI 1회 호출의 이유**: PR에 솔루션 파일이 5개 있으면 기존 설계는 OpenAI 호출 5회. 각 호출은 ~1-3초이므로 최대 15초. Workers timeout(10초) 위험이 크다. 모든 파일을 구분자(`===== {problemName} =====`)로 합쳐 1회 호출하면 latency는 1회분, 비용도 입출력 토큰 합산으로 비슷하거나 더 저렴하다.

---

## 3. 파일 변경 목록

### 신규
- `handlers/complexity-analysis.js` — 상수, OpenAI 호출, 댓글 포맷터, upsert, 오케스트레이션 **모두 포함**

### 수정
- `handlers/webhooks.js` — `handlePullRequestEvent`에 호출 추가 (기존 try/catch 패턴과 동일하게)

### 건드리지 않음
- `utils/openai.js` — 수정 없음
- `utils/constants.js` — 수정 없음
- `handlers/tag-patterns.js` — 다른 팀 스코프
- `handlers/learning-status.js` — 기존 기능
- index.js — 신규 엔드포인트 없음
- 인증/Webhook 검증 흐름

---

## 4. 데이터 흐름

```
pull_request (opened/reopened/synchronize)
        │
        ▼
handlePullRequestEvent  ── (기존) Week 체크
        │
        ├── (기존) try { tagPatterns(...) } catch { ... }
        ├── (기존) try { postLearningStatus(...) } catch { ... }
        └── (신규) try { analyzeComplexity(...) } catch { ... }
                           │
                           ▼
                   analyzeComplexity
                     1) GET /pulls/{n}/files?per_page=100
                     2) SOLUTION_PATH_REGEX 로 솔루션 파일 필터
                     3) 각 파일의 raw_url 다운로드 + trim
                     4) 모든 파일을 구분자로 합쳐 OpenAI 1회 호출
                        ┌─────────────────────────────┐
                        │ ===== problem-a =====        │
                        │ <코드 A>                     │
                        │                              │
                        │ ===== problem-b =====        │
                        │ <코드 B>                     │
                        └─────────────────────────────┘
                              ↓ (1회 API 호출)
                        ┌─────────────────────────────┐
                        │ { "files": [                 │
                        │   { "problemName": "problem-a",│
                        │     "solutions": [...] },    │
                        │   { "problemName": "problem-b",│
                        │     "solutions": [...] }     │
                        │ ]}                           │
                        └─────────────────────────────┘
                     5) formatComplexityCommentBody(parsedResult)
                          - 풀이 1개: 기존 테이블 포맷
                          - 풀이 2개+: <details> 접기 포맷
                     6) upsertComplexityComment(prNumber, body)
```

---

## 5. 상세 구현

### 5.1 `handlers/complexity-analysis.js` (신규 — 단일 파일)

이 파일 하나에 다음 요소를 모두 포함한다:

1. **상수**: `SOLUTION_PATH_REGEX`, `COMPLEXITY_COMMENT_MARKER`, `MAX_FILE_SIZE`, `MAX_TOTAL_SIZE`
2. **OpenAI 호출**: `callComplexityAnalysis()` — 모든 솔루션을 한 번에 분석
3. **댓글 포맷터**: `formatComplexityCommentBody()` — 단일/멀티 풀이 분기
4. **댓글 upsert**: `upsertComplexityComment()` — 마커 기반 생성/수정
5. **오케스트레이션**: `analyzeComplexity()` — export, webhooks.js에서 호출

```js
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
const MAX_TOTAL_SIZE = 60000; // 모든 파일 합산 최대 (OpenAI 입력 제한 고려)
const FILE_DELIMITER = "=====";

// ── OpenAI 호출 ───────────────────────────────────

const SYSTEM_PROMPT = `당신은 알고리즘 풀이의 시간/공간 복잡도를 분석하는 전문가입니다.

여러 문제의 솔루션 코드가 구분자(===== {문제명} =====)로 나뉘어 제공됩니다.
각 문제별로 독립적으로 분석하세요.

하나의 문제 안에 같은 문제를 여러 가지 방식으로 푼 풀이가 포함될 수 있습니다.
각 문제마다 코드에서 독립된 풀이가 몇 개인지 판별하세요. (함수/클래스/메서드 단위로 구분)

각 풀이에 대해:
1. name: 함수명 또는 식별 가능한 이름 (예: "twoSum_bruteForce", "Solution.maxArea")
2. description: 접근 방식 한 줄 설명 (예: "이진 탐색", "HashMap 활용")
3. 코드의 실제 시간/공간 복잡도를 Big-O 표기로 계산 (actualTime, actualSpace).
4. 해당 풀이 바로 위/근처에 사용자가 남긴 시간복잡도/공간복잡도 주석을 찾으세요.
   주석은 자유 포맷이며 언어별 주석 스타일(//, #, /* */, --, """)과 한/영 키워드가 섞일 수 있습니다.
   예: "// TC: O(n)", "# 시간복잡도: O(n log n)", "/* Space: O(1) */", "// Time: O(n^2)"
   - 찾았으면 hasUserAnnotation=true, userTime/userSpace에 사용자 값 그대로.
   - 한쪽만 적혀 있으면 다른 쪽은 null.
   - 전혀 없으면 hasUserAnnotation=false, userTime=null, userSpace=null.
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

/**
 * 모든 솔루션 파일을 한 번의 OpenAI 호출로 분석한다.
 *
 * @param {Array<{ problemName: string, content: string }>} fileEntries
 * @param {string} apiKey
 * @returns {Promise<Array<{ problemName: string, solutions: Array<object> }>>}
 */
async function callComplexityAnalysis(fileEntries, apiKey) {
  // 구분자로 모든 파일을 하나의 프롬프트로 합침
  const userPrompt = fileEntries
    .map((f) => `${FILE_DELIMITER} ${f.problemName} ${FILE_DELIMITER}\n\`\`\`\n${f.content}\n\`\`\``)
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
    problemName: typeof file.problemName === "string" ? file.problemName : "unknown",
    solutions: (Array.isArray(file.solutions) ? file.solutions : []).map((s) => ({
      name: typeof s.name === "string" ? s.name : "unknown",
      description: typeof s.description === "string" ? s.description : "",
      hasUserAnnotation: s.hasUserAnnotation === true,
      userTime: typeof s.userTime === "string" ? s.userTime : null,
      userSpace: typeof s.userSpace === "string" ? s.userSpace : null,
      actualTime: typeof s.actualTime === "string" ? s.actualTime : "?",
      actualSpace: typeof s.actualSpace === "string" ? s.actualSpace : "?",
      matches: {
        time: s.matches?.time === true,
        space: s.matches?.space === true,
      },
      feedback: typeof s.feedback === "string" ? s.feedback : "",
      suggestion: typeof s.suggestion === "string" ? s.suggestion : "",
    })),
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
    lines.push(`| **Time** | ${solution.userTime ?? "-"} | ${solution.actualTime} | ${solution.userTime ? timeMark : "-"} |`);
    lines.push(`| **Space** | ${solution.userSpace ?? "-"} | ${solution.actualSpace} | ${solution.userSpace ? spaceMark : "-"} |`);
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

/**
 * @param {Array<{ problemName: string, solutions: Array<object> }>} entries
 * @returns {string}
 */
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
    const hasAnyAnnotationMissing = solutions.some((s) => !s.hasUserAnnotation);

    if (isMulti) {
      lines.push(`> ℹ️ 이 파일에는 **${solutions.length}가지 풀이**가 포함되어 있어 각각 분석합니다.`);
      lines.push("");

      solutions.forEach((sol, idx) => {
        const summaryResult = buildSummaryResult(sol);
        lines.push(`<details>`);
        lines.push(`<summary>풀이 ${idx + 1}: <code>${sol.name}</code> — ${summaryResult}</summary>`);
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

async function upsertComplexityComment(repoOwner, repoName, prNumber, body, appToken) {
  const baseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}`;

  const listResponse = await fetch(
    `${baseUrl}/issues/${prNumber}/comments?per_page=100`,
    { headers: getGitHubHeaders(appToken) }
  );
  if (!listResponse.ok) {
    throw new Error(`Failed to list comments: ${listResponse.status} ${listResponse.statusText}`);
  }

  const comments = await listResponse.json();
  const existing = comments.find(
    (c) => c.user?.type === "Bot" && c.body?.includes(COMPLEXITY_COMMENT_MARKER)
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
      throw new Error(`Failed to update complexity comment ${existing.id}: ${res.status}`);
    }
    console.log(`[complexity] Updated comment ${existing.id} on PR #${prNumber}`);
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

/**
 * @param {string} repoOwner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {object} prData - PR 객체 (draft, labels)
 * @param {string} appToken
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
    throw new Error(`Failed to list PR files: ${filesRes.status} ${filesRes.statusText}`);
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
        console.error(`[complexity] Failed to fetch ${file.filename}: ${rawRes.status}`);
        continue;
      }
      let content = await rawRes.text();
      if (content.length > MAX_FILE_SIZE) {
        content = content.slice(0, MAX_FILE_SIZE);
      }

      // 합산 크기 제한
      if (totalSize + content.length > MAX_TOTAL_SIZE) {
        console.log(`[complexity] Reached MAX_TOTAL_SIZE, skipping remaining files`);
        break;
      }

      totalSize += content.length;
      fileEntries.push({ problemName, content });
    } catch (error) {
      console.error(`[complexity] Failed to download ${file.filename}: ${error.message}`);
    }
  }

  if (fileEntries.length === 0) {
    return { skipped: "all-downloads-failed" };
  }

  // 3) OpenAI 1회 호출로 모든 파일 분석
  const analysisResults = await callComplexityAnalysis(fileEntries, openaiApiKey);

  // 4) OpenAI 결과를 fileEntries 순서에 맞춰 매핑
  //    (OpenAI가 problemName을 반환하므로 매칭, 매칭 실패 시 순서 기반 fallback)
  const entries = fileEntries.map((fe) => {
    const match = analysisResults.find((r) => r.problemName === fe.problemName);
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
```

### 5.2 `handlers/webhooks.js` 통합

[handlers/webhooks.js:256-289](handlers/webhooks.js#L256-L289) 의 기존 두 try/catch 블록 뒤에, 동일한 패턴으로 신규 호출을 추가한다. **기존 코드는 수정하지 않는다.**

```js
// import 추가 (파일 상단)
import { analyzeComplexity } from "./complexity-analysis.js";

// handlePullRequestEvent 안, 기존 학습 현황 try/catch 블록(L274-289) 바로 뒤에 추가:

  // 시간/공간 복잡도 분석 (OPENAI_API_KEY 있을 때만)
  if (env.OPENAI_API_KEY) {
    try {
      await analyzeComplexity(
        repoOwner,
        repoName,
        prNumber,
        pr,
        appToken,
        env.OPENAI_API_KEY
      );
    } catch (error) {
      console.error(`[handlePullRequestEvent] complexity analysis failed: ${error.message}`);
      // 복잡도 분석 실패는 전체 흐름을 중단시키지 않음
    }
  }
```

> 기존 tagPatterns, postLearningStatus 호출은 그대로 둔다. 동일한 try/catch 순차 패턴을 유지하여 다른 기능에 영향을 주지 않는다.

---

## 6. 케이스별 출력 검증

### 케이스 1 (단일 풀이, 주석 일치)
```json
{ "files": [{
    "problemName": "container-with-most-water",
    "solutions": [{
      "name": "maxArea", "description": "투 포인터",
      "hasUserAnnotation": true,
      "userTime": "O(n)", "userSpace": "O(1)",
      "actualTime": "O(n)", "actualSpace": "O(1)",
      "matches": { "time": true, "space": true }
    }]
}]}
```
포맷터: 풀이 1개 → 접기 없이 비교 표 + ✅ 두 개 출력 → 이슈 케이스 1과 일치.

### 케이스 2 (단일 풀이, 불일치)
`matches.time=false`, `feedback`에 "다시 분석해보시는 것을 권장드립니다" 톤 → 이슈 케이스 2와 일치.

### 케이스 3 (단일 풀이, 주석 없음)
`hasUserAnnotation=false` → 단일 컬럼 표 + 안내 quote → 이슈 케이스 3과 일치.

### 케이스 4 (멀티 풀이, 주석 있음)
```json
{ "files": [{
    "problemName": "find-minimum-in-rotated-sorted-array",
    "solutions": [
      { "name": "findMin_use_math_min", "description": "Math.min 활용", "hasUserAnnotation": true, ... },
      { "name": "findMin_naive", "description": "선형 탐색", "hasUserAnnotation": true, ... },
      { "name": "findMin", "description": "이진 탐색", "hasUserAnnotation": true, ... }
    ]
}]}
```
포맷터: 풀이 3개 → `<details>` 접기 적용, 각 summary에 결과 표시 → 이슈 케이스 4와 일치.

### 케이스 5 (멀티 풀이, 주석 없음)
`hasUserAnnotation=false` → `<details>` 접기, summary에 복잡도만 표시 + 주석 작성 권장 → 이슈 케이스 5와 일치.

### 다중 파일 PR (1회 호출로 처리)
PR에 파일 3개 → 구분자로 합쳐 OpenAI 1회 호출 → `files[]` 배열에 3개 항목 → `### {problemName}` 섹션 3개의 단일 댓글.

---

## 7. 비용 / 안정성 메모

- **OpenAI 호출 횟수**: PR당 항상 1회. 파일 수와 무관. 기존 설계(파일당 1회) 대비 대폭 절감.
- **max_tokens**: 4000. 파일 5개 × 멀티 풀이까지 커버.
- **입력 크기 제한**: `MAX_TOTAL_SIZE = 60000`으로 모든 파일 합산 제한. 초과 시 남은 파일 skip.
- **개별 파일 다운로드 실패**: 해당 파일만 skip, 나머지 정상 진행. OpenAI 호출은 성공한 파일들만 대상.
- **OpenAI 호출 실패**: 전체 분석 실패 → try/catch에서 잡혀 console.error만 출력. 다른 기능에 영향 없음.
- **댓글 upsert**: 마커 기반이므로 PR에 push가 반복돼도 댓글은 1개로 유지.

---

## 8. 테스트 방법

### 로컬
```bash
wrangler dev   # http://localhost:8787

# webhook payload 시뮬레이션
curl -X POST http://localhost:8787/webhooks \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  --data @fixtures/pull_request_opened.json
```

### 수동 시나리오 (DaleStudy/leetcode-study 의 테스트 PR)
1. **케이스 1**: 솔루션 상단에 정확한 `// TC: O(n)` / `// SC: O(1)` 주석을 단 파일 하나 PR.
2. **케이스 2**: `// TC: O(n)` 인데 실제로는 정렬을 쓰는 코드 PR.
3. **케이스 3**: 주석 없는 솔루션 파일 PR.
4. **케이스 4**: 하나의 파일에 여러 풀이 + 각각 주석이 달린 PR (test.js 참고).
5. **케이스 5**: 하나의 파일에 여러 풀이 + 주석 없는 PR.
6. **다중 파일**: 두 폴더 이상 변경하는 PR → OpenAI 1회 호출로 모두 분석되는지.
7. **재푸시**: 같은 PR에 force push → 댓글이 PATCH 되는지.

각 시나리오에서 [tag-patterns.js](handlers/tag-patterns.js) 와 [learning-status.js](handlers/learning-status.js) 가 여전히 정상 동작하는지도 같이 확인 (회귀 방지).

---

## 9. 작업 순서 (체크리스트)

- [ ] `handlers/complexity-analysis.js` 신규 작성 (상수 + OpenAI 호출 + 댓글 포맷터 + upsert + 오케스트레이션)
- [ ] `handlers/webhooks.js`에 import + try/catch 블록 추가
- [ ] `wrangler dev`로 케이스 1~5 / 다중 파일 / 재푸시 수동 검증
- [ ] AGENTS.md 의 폴더 구조 / 기능 목록에 "시간/공간 복잡도 자동 분석" 추가 (간단히 한 줄)

---

## 10. 본 작업 범위 외 (의도적 제외)

research.md §7의 다음 항목들은 이번 PR에 **포함하지 않는다**:
- `ctx.waitUntil()` 도입
- `prReview.js` Content-Type / response.ok 일괄 보강
- PKCS1 분기 정리
- truncated tree 처리
- 라우팅 객체화
- 패턴 태깅의 변경 파일 한정 처리

기존 기능 소스코드 수정도 **포함하지 않는다**:
- `utils/openai.js` — 수정하지 않음
- `utils/constants.js` — 수정하지 않음
- `handlers/tag-patterns.js` — 다른 팀 스코프
- `handlers/learning-status.js` — 기존 기능 유지
- 기존 tagPatterns/postLearningStatus 호출 패턴 변경

이번 작업은 **신규 파일 1개 추가 + webhooks.js에 호출 1개 추가**만 한다.
