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
 * @returns {Promise<string>} AI가 생성한 리뷰 댓글 (마크다운)
 */
export async function generateCodeReview(prDiff, prTitle, prBody, apiKey) {
  const systemPrompt = `You are a code reviewer for a LeetCode study group.
Review the code changes and provide constructive feedback in Korean.

Focus on:
- Algorithm correctness and edge cases
- Time/Space complexity analysis
- Code readability and best practices
- Potential bugs or improvements
- Test coverage suggestions

Format your review in markdown with clear sections.
Be encouraging and educational, not just critical.`;

  const userPrompt = `# PR Title
${prTitle}

# PR Description
${prBody || 'No description provided'}

# Code Changes
\`\`\`diff
${prDiff}
\`\`\`

Please review this pull request.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
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
  return data.choices[0]?.message?.content || 'Failed to generate review';
}
