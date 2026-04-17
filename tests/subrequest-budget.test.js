import { describe, it, expect, vi, beforeEach } from "bun:test";

import { tagPatterns } from "../handlers/tag-patterns.js";
import { postLearningStatus } from "../handlers/learning-status.js";
import { analyzeComplexity } from "../handlers/complexity-analysis.js";

const REPO_OWNER = "DaleStudy";
const REPO_NAME = "leetcode-study";
const PR_NUMBER = 42;
const HEAD_SHA = "head-sha";
const USERNAME = "testuser";
const APP_TOKEN = "fake-app-token";
const OPENAI_KEY = "fake-openai-key";

const SOLUTION_FILES = Array.from({ length: 5 }, (_, i) => ({
  filename: `problem-${i + 1}/${USERNAME}.ts`,
  status: "added",
  raw_url: `https://raw.example.com/problem-${i + 1}/${USERNAME}.ts`,
}));

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

describe("subrequest 예산 — 핸들러별 invocation (변경 파일 5개)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tagPatterns 는 50 회 이하 subrequest 를 호출한다 (예상 22: files 1 + 코멘트 목록 1 + DELETE 5 + 5×(raw+openai+post))", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson(SOLUTION_FILES);
      }

      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson(
          SOLUTION_FILES.map((f, i) => ({
            id: 1000 + i,
            user: { type: "Bot" },
            body: "<!-- dalestudy-pattern-tag -->",
            path: f.filename,
          }))
        );
      }

      if (urlStr.includes("/pulls/comments/") && method === "DELETE") {
        return okJson({});
      }

      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() { return 0; }");
      }

      if (urlStr.includes("openai.com/v1/chat/completions")) {
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

      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 999 });
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

    expect(result.tagged).toBe(5);
    expect(fetchCount).toBe(22);
    expect(fetchCount).toBeLessThan(50);
  });

  it("postLearningStatus 는 50 회 이하 subrequest 를 호출한다 (예상 15: categories 1 + tree 1 + PR files 1 + 5×(raw+openai) + 이슈 코멘트 목록 1 + POST 1)", async () => {
    const categories = Object.fromEntries(
      SOLUTION_FILES.map((_, i) => [
        `problem-${i + 1}`,
        {
          difficulty: "Easy",
          categories: ["Array"],
          intended_approach: "Two Pointers",
        },
      ])
    );

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/contents/problem-categories.json")) {
        return okJson(categories);
      }

      if (urlStr.includes("/git/trees/main")) {
        return okJson({
          truncated: false,
          tree: SOLUTION_FILES.map((f) => ({ type: "blob", path: f.filename })),
        });
      }

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson(SOLUTION_FILES);
      }

      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() { return 0; }");
      }

      if (urlStr.includes("openai.com/v1/chat/completions")) {
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
    expect(fetchCount).toBe(15);
    expect(fetchCount).toBeLessThan(50);
  });

  it("analyzeComplexity 는 50 회 이하 subrequest 를 호출한다 (예상 9: PR files 1 + 5×raw + OpenAI 1 + 이슈 코멘트 목록 1 + POST 1)", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson(SOLUTION_FILES);
      }

      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("// TC: O(n)\n// SC: O(1)\nfunction solution() { return 0; }");
      }

      if (urlStr.includes("openai.com/v1/chat/completions")) {
        return okJson({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  files: SOLUTION_FILES.map((f, i) => ({
                    problemName: `problem-${i + 1}`,
                    solutions: [
                      {
                        name: "solution",
                        description: "기본 풀이",
                        hasUserAnnotation: true,
                        userTime: "O(n)",
                        userSpace: "O(1)",
                        actualTime: "O(n)",
                        actualSpace: "O(1)",
                        matches: { time: true, space: true },
                        feedback: "정확합니다!",
                        suggestion: "현재 구현이 적절해 보입니다.",
                      },
                    ],
                  })),
                }),
              },
            },
          ],
        });
      }

      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([]);
      }

      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 600 });
      }

      throw new Error(`Unexpected fetch in analyzeComplexity mock: ${method} ${urlStr}`);
    });

    const prData = { draft: false, labels: [] };
    const result = await analyzeComplexity(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      prData,
      APP_TOKEN,
      OPENAI_KEY
    );

    const fetchCount = globalThis.fetch.mock.calls.length;

    expect(result.analyzed).toBe(5);
    expect(result.total).toBe(5);
    expect(fetchCount).toBe(9);
    expect(fetchCount).toBeLessThan(50);
  });
});
