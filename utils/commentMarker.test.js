import { describe, expect, it } from "vitest";

import {
  parseFileShaMarker,
  renderFileShaMarker,
} from "./commentMarker.js";

const FILE_SHA = "a".repeat(40);

describe("패턴 분석 댓글 마커", () => {
  it("file SHA를 숨김 댓글로 렌더링한다", () => {
    expect(renderFileShaMarker(FILE_SHA)).toBe(
      `<!-- file-sha: ${FILE_SHA} -->`
    );
  });

  it("마커에서 file SHA를 파싱한다", () => {
    const body = `<!-- file-sha: ${FILE_SHA} -->`;

    expect(parseFileShaMarker(body)).toBe(FILE_SHA);
  });

  it.each([
    ["마커가 없는 경우", "분석 내용"],
    ["file SHA가 없는 경우", "<!-- -->"],
    ["file SHA가 16진수가 아닌 경우", "<!-- file-sha: zzzz -->"],
  ])("%s null을 반환한다", (_, body) => {
    expect(parseFileShaMarker(body)).toBeNull();
  });
});
