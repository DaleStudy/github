/**
 * GitHub Flavored Markdown(GFM) 유틸리티
 *
 * @see https://github.github.com/gfm/
 */

/**
 * 콘텐츠 내부의 연속된 백틱보다 긴 GFM 코드 fence를 생성한다.
 *
 * @param {string} content
 * @returns {string}
 * @see https://github.github.com/gfm/#fenced-code-blocks
 */
export function createCodeFence(content) {
  const longestBacktickLength = (content.match(/`+/g) ?? []).reduce(
    (maxLength, backticks) => Math.max(maxLength, backticks.length),
    0
  );

  const fenceLength = Math.max(3, longestBacktickLength + 1);
  return "`".repeat(fenceLength);
}
