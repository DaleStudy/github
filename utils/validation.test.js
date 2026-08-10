import { describe, it, expect } from "vitest";

import { isSolutionPR } from "./validation.js";

describe("isSolutionPR", () => {
  it("풀이 제출 PR 제목을 인식한다", () => {
    expect(isSolutionPR("[dale] WEEK 07 Solutions")).toBe(true);
    expect(isSolutionPR("[freemjstudio] WEEK 08 Solutions")).toBe(true);
    expect(isSolutionPR("[user] Week 1 solutions")).toBe(true);
    expect(isSolutionPR("[user] WEEK15 Solutions")).toBe(true);
  });

  it("봇 테스트나 저장소 정리 PR은 제외한다", () => {
    expect(isSolutionPR("260806 봇 댓글 기능 테스트")).toBe(false);
    expect(isSolutionPR("bot test")).toBe(false);
    expect(isSolutionPR("fix: 머지 방식을 squash로 바꾸고")).toBe(false);
    expect(isSolutionPR("README.md에 스터디 4기 정보 추가")).toBe(false);
  });

  it("Solutions를 빼먹은 제목도 풀이 PR로 인식한다", () => {
    expect(isSolutionPR("[chapse57] Week 3")).toBe(true);
  });

  it("제목이 없으면 false를 돌려준다", () => {
    expect(isSolutionPR(undefined)).toBe(false);
    expect(isSolutionPR(null)).toBe(false);
    expect(isSolutionPR("")).toBe(false);
  });
});
