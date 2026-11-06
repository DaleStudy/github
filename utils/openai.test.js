import { describe, expect, it } from "vitest";
import { sanitizePatterns } from "./openai.js";

describe("sanitizePatterns", () => {
  it("목록에 있는 패턴은 그대로 둔다", () => {
    expect(sanitizePatterns(["Two Pointers", "Greedy"])).toEqual([
      "Two Pointers",
      "Greedy",
    ]);
  });

  it("중복과 목록에 없는 이름을 걸러낸다", () => {
    expect(
      sanitizePatterns(["Two Pointers", "Two Pointers", "String Manipulation"])
    ).toEqual(["Two Pointers"]);
  });

  it("상한을 넘으면 빈 배열을 돌려준다", () => {
    expect(
      sanitizePatterns(["Two Pointers", "Greedy", "BFS", "DFS"])
    ).toEqual([]);
  });

  it("배열이 아니면 빈 배열을 돌려준다", () => {
    expect(sanitizePatterns(undefined)).toEqual([]);
  });
});
