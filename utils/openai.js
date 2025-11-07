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
export async function generateCodeReview(prDiff, prTitle, prBody, apiKey, userRequest = null) {
  const systemPrompt = `당신은 리트코드 스터디 그룹의 AI 코치입니다.
아래 코드 변경 사항을 리뷰하고 건설적인 피드백을 제공하세요.

리뷰 시 아래 항목에 집중합니다:
	•	시간/공간 복잡도 분석이 코멘트로 포함되지 않았다면 포함하도록 요청. 예를 들어, "TC: O(n), SC: O(1)" 정도만 표시해주면 충분
  •	시간/공간 복잡도 분석이 정확한지 평가
  •	더 나은 접근법이나 알고리즘이 있는지 제안
  •	코드의 가독성 및 스타일, 베스트 프랙티스 준수 여부
	•	잠재적인 버그 또는 개선 가능성

단순히 지적만 하지 말고, 격려와 학습이 되는 피드백을 함께 주세요. 
해당 사항없는 항목은 생략하고 자연스럽게 작성하세요.
300 글자를 초과하지 말아주세요.
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
    userPrompt += `\n# User's Specific Request\n${userRequest}\n\nPlease review this pull request, focusing on the user's specific request.`;
  } else {
    userPrompt += `\nPlease review this pull request.`;
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
