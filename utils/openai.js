/**
 * OpenAI API 통합 (AI Gateway 경유)
 */
import { AI_GATEWAY_RETRY_HEADERS, OPENAI_CHAT_COMPLETIONS_URL } from "./constants.js";

/**
 * PR diff를 분석하여 AI 코드 리뷰 생성
 *
 * @param {string} prDiff - PR의 diff 내용
 * @param {string} prTitle - PR 제목
 * @param {string} prBody - PR 본문
 * @param {string} gatewayToken - AI Gateway 인증 토큰
 * @param {string} userRequest - 사용자의 구체적인 요청 (선택사항)
 * @returns {Promise<string>} AI가 생성한 리뷰 댓글 (마크다운)
 */
export async function generateCodeReview(
  prDiff,
  prTitle,
  prBody,
  gatewayToken,
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

[작성 규칙 — 반드시 지킬 것]
- 전체 응답은 한국어 기준 500자 이내. 절대 초과하지 마세요. 분량이 넘칠 것 같으면 가장 중요한 피드백만 남기고 나머지는 생략하세요.
- 한국어로만 작성하세요. 중국어·일본어 한자나 다른 언어를 섞지 마세요(예: "一致" 금지, "일치" 사용).
- 항목은 3개 이내로 압축하고, 장황한 설명 없이 핵심만 간결하게 쓰세요.
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

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${gatewayToken}`,
      "Content-Type": "application/json",
      ...AI_GATEWAY_RETRY_HEADERS,
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 3000,
      reasoning_effort: "minimal",
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
 * @param {string} gatewayToken - AI Gateway 인증 토큰
 * @returns {Promise<{patterns: string[], description: string}>}
 */
export async function generatePatternAnalysis(fileContent, problemName, gatewayToken) {
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

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${gatewayToken}`,
      "Content-Type": "application/json",
      ...AI_GATEWAY_RETRY_HEADERS,
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 2000,
      reasoning_effort: "minimal",
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
 * @param {string} gatewayToken - AI Gateway 인증 토큰
 * @returns {Promise<{matches: boolean, explanation: string}>}
 */
export async function generateApproachAnalysis(fileContent, problemName, problemInfo, gatewayToken) {
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

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${gatewayToken}`,
      "Content-Type": "application/json",
      ...AI_GATEWAY_RETRY_HEADERS,
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 1500,
      reasoning_effort: "minimal",
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
