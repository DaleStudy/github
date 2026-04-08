/**
 * OpenAI API 통합 (GPT-4.1-nano)
 */

/**
 * PR diff를 분석하여 AI 코드 리뷰 생성
 *
 * @param {string} prDiff - PR의 diff 내용
 * @param {string} prTitle - PR 제목
 * @param {string} prBody - PR 본문
 * @param {string} apiKey - OpenAI API 키
 * @param {string} userRequest - 사용자의 구체적인 요청 (선택사항)
 * @returns {Promise<string>} AI가 생성한 리뷰 댓글 (마크다운)
 */
export async function generateCodeReview(
  prDiff,
  prTitle,
  prBody,
  apiKey,
  userRequest = null
) {
  // userRequest가 있으면 Q&A 모드, 없으면 전체 리뷰 모드
  const systemPrompt = userRequest
    ? `당신은 리트코드 스터디 그룹의 AI 코치입니다.
사용자가 PR의 코드에 대해 구체적인 질문을 했습니다.
PR의 코드 변경 사항을 참고하여 사용자의 질문에 명확하고 도움이 되는 답변을 제공하세요.
300 글자를 초과하지 말아주세요.`
    : `당신은 리트코드 스터디 그룹의 AI 코치입니다.
아래 코드 변경 사항을 리뷰하고 건설적인 피드백을 제공하세요.

리뷰 시 아래 항목에 집중합니다:
	•	시간/공간 복잡도 분석이 코멘트로 포함되지 않았다면 포함하도록 요청. 예를 들어, "TC: O(n), SC: O(1)" 정도만 표시해주면 충분
  •	시간/공간 복잡도 분석이 정확한지 평가
  •	더 나은 접근법이나 알고리즘이 있는지 제안
  •	코드의 가독성 및 스타일, 베스트 프랙티스 준수 여부
	•	불필요한 nickpick은 피하고, 꼭 필요한 피드백만 주세요.

단순히 지적만 하지 말고, 격려와 학습이 되는 피드백을 함께 주세요.
해당 사항없는 항목은 생략하고 자연스럽게 작성하세요.
500 글자를 초과하지 말아주세요.
`;

  let userPrompt = `# PR Title
${prTitle}

# PR Description
${prBody || "No description provided"}

# Code Changes
\`\`\`diff
${prDiff}
\`\`\`
`;

  if (userRequest) {
    userPrompt += `\n# 사용자 질문\n${userRequest}`;
  } else {
    userPrompt += `\n이 풀 리퀘스트를 리뷰해주세요.`;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || "Failed to generate review";
}

/**
 * 솔루션 파일의 알고리즘 패턴 분석
 *
 * @param {string} fileContent - 분석할 소스 코드 내용
 * @param {string} problemName - 문제 이름 (폴더명)
 * @param {string} apiKey - OpenAI API 키
 * @returns {Promise<{patterns: string[], description: string}>}
 */
export async function generatePatternAnalysis(fileContent, problemName, apiKey) {
  const systemPrompt = `당신은 리트코드 문제 풀이의 알고리즘 패턴을 분석하는 전문가입니다.
주어진 소스 코드를 분석해서, 다음 패턴 목록 중 해당되는 것만 골라주세요.

감지 대상 패턴:
- Two Pointers
- Sliding Window
- Fast & Slow Pointers
- BFS
- DFS
- Backtracking
- Dynamic Programming
- Binary Search
- Monotonic Stack
- Heap / Priority Queue
- Hash Map / Hash Set
- Greedy
- Divide and Conquer
- Union Find
- Trie
- Bit Manipulation

반드시 JSON 객체로만 응답하세요. 형식:
{
  "patterns": ["패턴1", "패턴2"],
  "description": "이 코드가 왜 해당 패턴에 속하는지 간단한 한국어 설명 (2-3문장)"
}

규칙:
- patterns는 위 목록의 정확한 이름만 사용
- 해당 패턴이 없으면 빈 배열
- 일반적으로 1-3개 패턴이면 충분
- description은 150자 이내`;

  const userPrompt = `# 문제 이름
${problemName}

# 소스 코드
\`\`\`
${fileContent}
\`\`\`

위 코드에 사용된 알고리즘 패턴을 분석해주세요.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 500,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  const parsed = JSON.parse(content);

  return {
    patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
    description: typeof parsed.description === "string" ? parsed.description : "",
  };
}

/**
 * 솔루션 코드가 의도된 알고리즘 접근법과 일치하는지 분석
 *
 * @param {string} fileContent - 분석할 소스 코드 내용
 * @param {string} problemName - 문제 이름 (폴더명)
 * @param {{difficulty: string, categories: string[], intended_approach: string}} problemInfo - 문제 메타 정보
 * @param {string} apiKey - OpenAI API 키
 * @returns {Promise<{matches: boolean, explanation: string}>}
 */
export async function generateApproachAnalysis(fileContent, problemName, problemInfo, apiKey) {
  const systemPrompt = `You are an algorithm analysis expert. Determine if code matches the intended approach.

Respond with a JSON object in this exact format:
{
  "matches": true or false,
  "explanation": "한국어로 1문장, 80자 이내"
}

Rules:
- matches=true if the core data structure or algorithm matches the intended approach (does not need to be identical)
- matches=false if brute force was used when an optimized approach was intended
- Keep explanation to 1 sentence in Korean, 80 characters or fewer`;

  const truncatedContent = fileContent.slice(0, 15000);

  const userPrompt = `# 문제 이름
${problemName}

# 문제 정보
- 난이도: ${problemInfo.difficulty}
- 카테고리: ${(problemInfo.categories || []).join(", ")}
- 의도된 접근법: ${problemInfo.intended_approach}

# 소스 코드
\`\`\`
${truncatedContent}
\`\`\`

위 코드가 의도된 접근법과 일치하는지 분석해주세요.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 200,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${content.slice(0, 200)}`);
  }

  return {
    matches: parsed.matches === true,
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    usage: data.usage ?? null,
  };
}

/**
 * 여러 솔루션 파일의 접근법 일치 여부를 한 번의 API 호출로 일괄 분석.
 * subrequest 수를 줄이기 위해 파일당 개별 호출 대신 배치로 처리한다.
 *
 * @param {Array<{problemName: string, fileContent: string, problemInfo: object}>} items
 * @param {string} apiKey - OpenAI API 키
 * @returns {Promise<{results: Array<{matches: boolean, explanation: string}>, usage: object|null}>}
 */
export async function generateBatchApproachAnalysis(items, apiKey) {
  if (items.length === 0) return { results: [], usage: null };

  // 단건이면 기존 함수 위임
  if (items.length === 1) {
    const { fileContent, problemName, problemInfo } = items[0];
    const result = await generateApproachAnalysis(fileContent, problemName, problemInfo, apiKey);
    return {
      results: [{ matches: result.matches, explanation: result.explanation }],
      usage: result.usage,
    };
  }

  const systemPrompt = `You are an algorithm analysis expert. You will receive multiple problems. For each one, determine if the submitted code matches the intended approach.

Respond with a JSON object containing a "results" array with exactly ${items.length} entries, in the same order as the input:
{
  "results": [
    { "matches": true, "explanation": "한국어 1문장, 80자 이내" },
    ...
  ]
}

Rules:
- matches=true if the core data structure or algorithm matches the intended approach
- matches=false if brute force was used when an optimized approach was intended
- Keep each explanation to 1 sentence in Korean, 80 characters or fewer
- You MUST return exactly ${items.length} results`;

  const MAX_BATCH_FILE_SIZE = 5000;

  const problemSections = items.map(({ problemName, fileContent, problemInfo }, i) => {
    const truncated = fileContent.slice(0, MAX_BATCH_FILE_SIZE);
    return `## 문제 ${i + 1}: ${problemName}
- 난이도: ${problemInfo.difficulty}
- 카테고리: ${(problemInfo.categories || []).join(", ")}
- 의도된 접근법: ${problemInfo.intended_approach}

\`\`\`
${truncated}
\`\`\``;
  });

  const userPrompt = problemSections.join("\n\n") +
    `\n\n위 ${items.length}개 코드가 각각 의도된 접근법과 일치하는지 분석해주세요.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 200 * items.length,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI batch API error: ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from OpenAI batch analysis");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${content.slice(0, 200)}`);
  }

  const rawResults = parsed.results;
  if (!Array.isArray(rawResults)) {
    throw new Error(`OpenAI did not return a results array`);
  }

  if (rawResults.length !== items.length) {
    console.warn(
      `[generateBatchApproachAnalysis] Expected ${items.length} results, got ${rawResults.length}`
    );
  }

  const results = items.map((_, i) => {
    const r = rawResults[i];
    return {
      matches: r?.matches === true,
      explanation: typeof r?.explanation === "string" ? r.explanation : "",
    };
  });

  return { results, usage: data.usage ?? null };
}

/**
 * 솔루션의 시간/공간 복잡도 분석.
 * 사용자가 코드 어딘가에 자유 포맷으로 남긴 TC/SC 주석을 함께 추출하여
 * 비교 가능하도록 반환한다.
 *
 * @param {string} fileContent - 분석할 소스 코드
 * @param {string} problemName - 문제 이름 (폴더명)
 * @param {string} apiKey - OpenAI API 키
 * @returns {Promise<{
 *   hasUserAnnotation: boolean,
 *   userTime: string|null,
 *   userSpace: string|null,
 *   actualTime: string,
 *   actualSpace: string,
 *   matches: { time: boolean, space: boolean },
 *   feedback: string,
 *   suggestion: string
 * }>}
 */
export async function generateComplexityAnalysis(fileContent, problemName, apiKey) {
  const systemPrompt = `당신은 알고리즘 풀이의 시간/공간 복잡도를 분석하는 전문가입니다.

작업:
1. 코드의 실제 시간/공간 복잡도를 Big-O 표기로 계산하세요 (actualTime, actualSpace).
2. 코드 어디든(상단/하단/중간) 사용자가 남긴 시간복잡도/공간복잡도 주석이 있는지 찾으세요.
   주석은 자유 포맷이며 언어별 주석 스타일(//, #, /* */, --, """)과 한/영 키워드가 섞일 수 있습니다.
   예: "// TC: O(n)", "# 시간복잡도: O(n log n)", "/* Space: O(1) */", "// Time: O(n^2)"
   - 찾았으면 hasUserAnnotation=true 로 두고 userTime/userSpace 에 사용자가 적은 값을 그대로 옮기세요.
   - 한쪽만 적혀 있으면 다른 쪽은 null.
   - 전혀 없으면 hasUserAnnotation=false, userTime=null, userSpace=null.
3. matches.time / matches.space:
   - hasUserAnnotation=false 면 둘 다 false.
   - 사용자 값이 있는 항목만 actual 과 비교하여 일치 여부를 boolean 으로 반환.
4. feedback (한국어 1-3문장):
   - 일치하면: 칭찬 + 핵심 근거 짧게.
   - 불일치하면: 어디가 왜 다른지 설명 + "다시 풀어보시는 것을 권장드립니다" 톤.
   - 주석이 없으면: 풀이 핵심 근거 + 끝에 "풀이에 시간/공간 복잡도를 주석으로 남겨보세요" 안내.
5. suggestion (한국어):
   - 의미 있는 한 단계 이상 개선 여지가 있을 때만 제안 (예: O(n^2) → O(n)).
   - 문제 제약을 모를 수 있으므로 단정 금지. "고려해볼 만한 대안:" 톤.
   - 개선 여지가 없으면 "현재 구현이 적절해 보입니다." 한 문장.
   - 항상 string (빈 문자열 아님).

반드시 아래 JSON 스키마로만 응답:
{
  "hasUserAnnotation": boolean,
  "userTime": string|null,
  "userSpace": string|null,
  "actualTime": string,
  "actualSpace": string,
  "matches": { "time": boolean, "space": boolean },
  "feedback": string,
  "suggestion": string
}`;

  const truncated = fileContent.slice(0, 15000);

  const userPrompt = `# 문제 이름
${problemName}

# 소스 코드
\`\`\`
${truncated}
\`\`\`

위 코드의 시간/공간 복잡도를 분석하고, 사용자가 남긴 복잡도 주석이 있다면 함께 추출해주세요.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${content.slice(0, 200)}`);
  }

  return {
    hasUserAnnotation: parsed.hasUserAnnotation === true,
    userTime: typeof parsed.userTime === "string" ? parsed.userTime : null,
    userSpace: typeof parsed.userSpace === "string" ? parsed.userSpace : null,
    actualTime: typeof parsed.actualTime === "string" ? parsed.actualTime : "?",
    actualSpace: typeof parsed.actualSpace === "string" ? parsed.actualSpace : "?",
    matches: {
      time: parsed.matches?.time === true,
      space: parsed.matches?.space === true,
    },
    feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : "",
  };
}
