/**
 * GitHub 댓글 숨김 마커 유틸리티
 */

const FILE_SHA_MARKER = "file-sha";
const FILE_SHA_PATTERN = new RegExp(
  `<!-- ${FILE_SHA_MARKER}: ([a-f0-9]+) -->`,
  "i"
);

/**
 * @param {string} fileSha
 * @returns {string}
 */
export function renderFileShaMarker(fileSha) {
  return `<!-- ${FILE_SHA_MARKER}: ${fileSha} -->`;
}

/**
 * @param {string} body
 * @returns {string|null}
 */
export function parseFileShaMarker(body) {
  return body.match(FILE_SHA_PATTERN)?.[1] ?? null;
}
