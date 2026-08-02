import { describe, it, expect } from "vitest";

import { createCodeFence } from "./markdown.js";

const backticks = (count) => "`".repeat(count);

describe("createCodeFence", () => {
  it.each([
    ["없으면", "plain text"],
    ["1개면", backticks(1)],
    ["2개면", backticks(2)],
  ])("연속 백틱이 %s 길이 3인 fence를 반환한다", (_case, content) => {
    expect(createCodeFence(content)).toBe(backticks(3));
  });

  it.each([3, 4, 5, 6])(
    "연속 백틱이 %i개면 하나 더 긴 fence를 반환한다",
    (count) => {
      expect(createCodeFence(backticks(count))).toBe(backticks(count + 1));
    }
  );

  it.each([
    `${backticks(5)}\n\n${backticks(3)}`,
    `${backticks(3)}\n\n${backticks(5)}\n\n${backticks(3)}`,
    `${backticks(3)}\n\n${backticks(5)}`,
  ])(
    "여러 묶음은 위치와 상관없이 가장 긴 연속 백틱을 기준으로 한다",
    (content) => {
      expect(createCodeFence(content)).toBe(backticks(6));
    }
  );
});
