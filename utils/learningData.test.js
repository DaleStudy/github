import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchCohortSolvedProblems } from "./learningData.js";

function pr(paths, projects) {
  return {
    projectsV2: { nodes: projects },
    files: { nodes: paths.map((path) => ({ path })) },
  };
}

describe("fetchCohortSolvedProblems", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("열린 기수 프로젝트에 속한 PR 에서 작성자의 풀이 파일만 모은다", async () => {
    const open = { title: "리트코드 스터디 9기", closed: false };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            search: {
              nodes: [
                pr(["two-sum/learner.py", "README.md", "two-sum/other.py"], [open]),
                pr(["valid-parentheses/learner.py"], [open]),
                pr(["climbing-stairs/learner.py"], [{ title: "리트코드 스터디 8기", closed: true }]),
                pr(["house-robber/learner.py"], []),
              ],
            },
          },
        }),
    });

    const solved = await fetchCohortSolvedProblems("DaleStudy", "leetcode-study", "learner", "token");

    expect(solved).toEqual(["two-sum", "valid-parentheses"]);
    const { variables } = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(variables.q).toBe(
      "repo:DaleStudy/leetcode-study is:pr is:merged author:learner sort:created-desc"
    );
  });

  it("GraphQL 에러가 오면 throw 한다", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ errors: [{ message: "bad" }] }),
    });

    await expect(
      fetchCohortSolvedProblems("DaleStudy", "leetcode-study", "learner", "token")
    ).rejects.toThrow("GraphQL error");
  });
});
