import { describe, it, expect, vi, beforeEach } from "vitest";

import { aiReview } from "../handlers/ai-review.js";
import { createFakeAi } from "./fakeAi.js";

const REPO_OWNER = "DaleStudy";
const REPO_NAME = "leetcode-study";
const PR_NUMBER = 42;
const HEAD_SHA = "head-sha";
const USERNAME = "testuser";
const APP_TOKEN = "fake-app-token";
const AI = createFakeAi();

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

describe("subrequest 예산 — AI 리뷰 invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aiReview 는 변경 파일 15개에서 50회 이하 subrequest를 호출한다 (예상 40: files 1 + raw 15 + categories 1 + 패턴 OpenAI 15 + 복잡도 OpenAI 1 + 기수 풀이 GraphQL 1 + check run 1 + issue 코멘트 목록 1 + PR head 조회 1 + 링크 댓글 POST 1 + 레거시 DELETE 2)", async () => {
    const solutionFiles = makeSolutionFiles(15);
    const categories = Object.fromEntries(
      solutionFiles.map((_, i) => [
        `problem-${i + 1}`,
        {
          difficulty: "Easy",
          blindCategories: ["Array"],
          intended_approach: "Two Pointers",
        },
      ])
    );

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson(solutionFiles);
      }

      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() { return 0; }");
      }

      if (urlStr.includes("/contents/problem-categories.json")) {
        return okJson(categories);
      }

      if (urlStr === "https://api.github.com/graphql") {
        return okJson({
          data: {
            search: {
              nodes: [
                {
                  projectsV2: { nodes: [{ title: "리트코드 스터디 9기", closed: false }] },
                  files: { nodes: [{ path: `problem-1/${USERNAME}.ts` }] },
                },
              ],
            },
          },
        });
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
                  matchesIntendedApproach: true,
                  approachExplanation: "일치",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
      }

      if (urlStr.endsWith("/check-runs") && method === "POST") {
        return okJson({ id: 777, html_url: "https://github.com/runs/777" });
      }

      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 500 });
      }

      if (urlStr.endsWith(`/pulls/${PR_NUMBER}`) && method === "GET") {
        return okJson({ head: { sha: HEAD_SHA } });
      }

      // 레거시 issue comment 마이그레이션 (단독 복잡도, 학습 현황)
      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([
          {
            id: 9998,
            user: { type: "Bot" },
            body: "<!-- dalestudy-complexity-analysis -->\n레거시",
          },
          {
            id: 9999,
            user: { type: "Bot" },
            body: "<!-- dalestudy-learning-status -->\n레거시",
          },
        ]);
      }
      if (urlStr.includes("/issues/comments/") && method === "DELETE") {
        return okJson({});
      }

      throw new Error(`Unexpected fetch in aiReview mock: ${method} ${urlStr}`);
    });

    const prData = { draft: false, labels: [], user: { login: USERNAME } };
    const result = await aiReview(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      HEAD_SHA,
      prData,
      APP_TOKEN,
      AI
    );

    const fetchCount = globalThis.fetch.mock.calls.length;

    expect(result.analyzed).toBe(15);
    expect(fetchCount).toBe(40);
    expect(fetchCount).toBeLessThanOrEqual(50);
  });
});
