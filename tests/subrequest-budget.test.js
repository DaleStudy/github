import { describe, it, expect, vi, beforeEach } from "vitest";

import { tagPatterns } from "../handlers/tag-patterns.js";
import { postLearningStatus } from "../handlers/learning-status.js";

const REPO_OWNER = "DaleStudy";
const REPO_NAME = "leetcode-study";
const PR_NUMBER = 42;
const HEAD_SHA = "head-sha";
const USERNAME = "testuser";
const APP_TOKEN = "fake-app-token";
const OPENAI_KEY = "fake-openai-key";

function makeSolutionFiles(count) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `problem-${i + 1}/${USERNAME}.ts`,
    status: "added",
    sha: "a".repeat(40),
    raw_url: `https://raw.example.com/problem-${i + 1}/${USERNAME}.ts`,
  }));
}

function okJson(data) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function okText(text) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(text),
  });
}

describe("subrequest 예산 — 핸들러별 invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tagPatterns 는 변경 파일 15개에서 50회 이하 subrequest를 호출한다 (예상 50: files 1 + 리뷰 코멘트 목록 1 + raw 15 + 패턴 OpenAI 15 + 복잡도 OpenAI 1 + POST 15 + 레거시 issue 코멘트 목록 1 + 레거시 DELETE 1)", async () => {
    const solutionFiles = makeSolutionFiles(15);

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson(solutionFiles);
      }

      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() { return 0; }");
      }

      if (urlStr.includes("/openai/chat/completions")) {
        const body = JSON.parse(opts.body);
        const isComplexity = body.messages[0].content.includes(
          "시간/공간 복잡도를 분석"
        );
        if (isComplexity) {
          return okJson({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    files: solutionFiles.map((_, i) => ({
                      problemName: `problem-${i + 1}`,
                      solutions: [
                        {
                          name: "solution",
                          headerLine: 1,
                          actualTime: "O(n)",
                          actualSpace: "O(1)",
                          feedback: "fb",
                          suggestion: "sg",
                        },
                      ],
                    })),
                  }),
                },
              },
            ],
          });
        }
        return okJson({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  patterns: ["Two Pointers"],
                  description: "test",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
      }

      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([]);
      }

      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 999 });
      }

      // 레거시 단독 복잡도 issue comment 마이그레이션
      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([
          {
            id: 9999,
            user: { type: "Bot" },
            body: "<!-- dalestudy-complexity-analysis -->\n레거시",
          },
        ]);
      }
      if (urlStr.includes("/issues/comments/") && method === "DELETE") {
        return okJson({});
      }

      throw new Error(`Unexpected fetch in tagPatterns mock: ${method} ${urlStr}`);
    });

    const prData = { draft: false, labels: [] };
    const result = await tagPatterns(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      HEAD_SHA,
      prData,
      APP_TOKEN,
      OPENAI_KEY
    );

    const fetchCount = globalThis.fetch.mock.calls.length;

    expect(result.tagged).toBe(15);
    expect(fetchCount).toBe(50);
    expect(fetchCount).toBeLessThanOrEqual(50);
  });

  it("postLearningStatus 는 50 회 이하 subrequest 를 호출한다 (예상 31: categories 1 + GraphQL project 1 + GraphQL items 1 + cohort PR files 15 + PR files 1 + 5×(raw+openai) + 이슈 코멘트 목록 1 + POST 1)", async () => {
    const solutionFiles = makeSolutionFiles(5);
    const categories = Object.fromEntries(
      solutionFiles.map((_, i) => [
        `problem-${i + 1}`,
        {
          difficulty: "Easy",
          categories: ["Array"],
          blindCategories: ["Array"],
          intended_approach: "Two Pointers",
        },
      ])
    );

    // 한 프로젝트(기수)당 최대 15개 PR 가정 — 유저가 cohort 에서 머지한 PR 15개
    const COHORT_PR_COUNT = 15;
    const COHORT_PR_NUMBERS = Array.from(
      { length: COHORT_PR_COUNT },
      (_, i) => PR_NUMBER - 1 - i
    );
    const COHORT_PROJECT_ID = "PVT_kwDO_cohort";

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/contents/problem-categories.json")) {
        return okJson(categories);
      }

      if (urlStr === "https://api.github.com/graphql" && method === "POST") {
        const body = JSON.parse(opts.body);
        if (body.query.includes("projectsV2")) {
          return okJson({
            data: {
              repository: {
                projectsV2: {
                  nodes: [
                    { id: COHORT_PROJECT_ID, title: "리트코드 스터디 9기", closed: false },
                  ],
                },
              },
            },
          });
        }
        if (body.query.includes("ProjectV2")) {
          return okJson({
            data: {
              node: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: COHORT_PR_NUMBERS.map((n) => ({
                    content: {
                      number: n,
                      state: "MERGED",
                      author: { login: USERNAME },
                    },
                  })),
                },
              },
            },
          });
        }
        throw new Error(`Unexpected GraphQL query: ${body.query}`);
      }

      if (COHORT_PR_NUMBERS.some((n) => urlStr.includes(`/pulls/${n}/files`))) {
        return okJson(solutionFiles);
      }

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson(solutionFiles);
      }

      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() { return 0; }");
      }

      if (urlStr.includes("/openai/chat/completions")) {
        return okJson({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  matches: true,
                  explanation: "의도된 접근법과 일치",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
      }

      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([]);
      }

      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 500 });
      }

      throw new Error(`Unexpected fetch in postLearningStatus mock: ${method} ${urlStr}`);
    });

    const result = await postLearningStatus(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      USERNAME,
      APP_TOKEN,
      OPENAI_KEY
    );

    const fetchCount = globalThis.fetch.mock.calls.length;

    expect(result.analyzed).toBe(5);
    expect(fetchCount).toBe(31);
    expect(fetchCount).toBeLessThan(50);
  });

});
