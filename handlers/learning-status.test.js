import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/learningData.js", () => ({
  fetchProblemCategories: vi.fn(),
  fetchCohortUserSolutions: vi.fn(),
  fetchPRSubmissions: vi.fn(),
}));

vi.mock("../utils/openai.js", () => ({
  generateApproachAnalysis: vi.fn(),
}));

import { postLearningStatus } from "./learning-status.js";
import {
  fetchProblemCategories,
  fetchCohortUserSolutions,
  fetchPRSubmissions,
} from "../utils/learningData.js";
import { generateApproachAnalysis } from "../utils/openai.js";

describe("postLearningStatus — 누적 풀이 집계", () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    fetchProblemCategories.mockResolvedValue({
      "two-sum": {
        difficulty: "Easy",
        blindCategories: ["Array"],
        intended_approach: "Hash Table",
      },
    });
    fetchPRSubmissions.mockResolvedValue([
      { problemName: "two-sum", rawUrl: "https://example.com/solution.py" },
    ]);
    generateApproachAnalysis.mockResolvedValue({
      matches: true,
      explanation: "Uses a hash table",
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("class Solution: pass"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      })
      .mockResolvedValueOnce({ ok: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    {
      name: "등록된 문제의 풀이 수를 유지한다",
      solved: ["two-sum"],
      expected: 1,
    },
    {
      name: "미등록 문제가 섞여 있으면 등록된 문제만 집계한다",
      solved: ["to-lower-case", "two-sum"],
      expected: 1,
    },
    {
      name: "미등록 문제만 풀었으면 풀이 수는 0이다",
      solved: ["to-lower-case"],
      expected: 0,
    },
  ])("$name", async ({ solved, expected }) => {
    fetchCohortUserSolutions.mockResolvedValue(solved);

    await postLearningStatus(
      "DaleStudy",
      "leetcode-study",
      42,
      "learner",
      "token",
      {}
    );

    const post = globalThis.fetch.mock.calls.find(
      ([, options]) => options?.method === "POST"
    );
    expect(post).toBeDefined();

    const body = JSON.parse(post[1].body).body;
    expect(body).toContain(`풀이한 문제: ${expected} / 1개`);
  });
});
