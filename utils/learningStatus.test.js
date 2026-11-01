import { describe, it, expect } from "vitest";

import { renderLearningStatus } from "./learningStatus.js";

const CATEGORIES = {
  "two-sum": { difficulty: "Easy", blindCategories: ["Array"] },
  "valid-parentheses": { difficulty: "Easy", blindCategories: ["String"] },
};

describe("renderLearningStatus", () => {
  it.each([
    { name: "등록된 문제의 풀이 수를 센다", solved: ["two-sum"], expected: 1 },
    {
      name: "미등록 문제가 섞여 있으면 등록된 문제만 센다",
      solved: ["to-lower-case", "two-sum"],
      expected: 1,
    },
    { name: "미등록 문제만 풀었으면 0이다", solved: ["to-lower-case"], expected: 0 },
  ])("$name", ({ solved, expected }) => {
    expect(renderLearningStatus("learner", CATEGORIES, solved)).toContain(
      `이번 기수에 푼 문제: ${expected} / 2개`
    );
  });

  it("진행도가 높은 카테고리를 먼저 보여준다", () => {
    const markdown = renderLearningStatus("learner", CATEGORIES, ["valid-parentheses"]);

    expect(markdown.indexOf("| String |")).toBeLessThan(markdown.indexOf("| Array |"));
    expect(markdown).toContain("| String | ■■■■■■■ | 1 / 1 (Easy 1) |");
    expect(markdown).toContain("| Array | □□□□□□□ | 0 / 1 |");
  });
});
