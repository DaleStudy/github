import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { postLearningStatus } from "./learning-status.js";
import {
  fetchProblemCategories,
  fetchCohortUserSolutions,
  fetchPRSubmissions,
} from "../utils/learningData.js";
import { generateApproachAnalysis } from "../utils/openai.js";
import { upsertLearningStatusComment } from "../utils/learningComment.js";

vi.mock("../utils/learningData.js", () => ({
  fetchProblemCategories: vi.fn(),
  fetchCohortUserSolutions: vi.fn(),
  fetchPRSubmissions: vi.fn(),
}));

vi.mock("../utils/openai.js", () => ({
  generateApproachAnalysis: vi.fn(),
}));

vi.mock("../utils/learningComment.js", async (importOriginal) => ({
  ...(await importOriginal()),
  upsertLearningStatusComment: vi.fn(),
}));

describe("postLearningStatus progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "class Solution: pass",
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { solved: ["two-sum"], expected: 1 },
    { solved: ["to-lower-case", "two-sum"], expected: 1 },
    { solved: ["to-lower-case"], expected: 0 },
  ])(
    "counts $solved as $expected catalogued problems",
    async ({ solved, expected }) => {
      fetchCohortUserSolutions.mockResolvedValue(solved);

      await postLearningStatus(
        "DaleStudy", "leetcode-study", 42, "learner", "token", {}
      );

      expect(upsertLearningStatusComment).toHaveBeenCalledWith(
        "DaleStudy",
        "leetcode-study",
        42,
        expect.stringContaining(`풀이한 문제: ${expected} / 1개`),
        "token",
        null
      );
    }
  );
});
