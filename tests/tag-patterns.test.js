import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/github.js", () => ({
  getGitHubHeaders: vi.fn((token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "DaleStudy-GitHub-App",
  })),
}));

import { tagPatterns } from "../handlers/tag-patterns.js";

const REPO_OWNER = "DaleStudy";
const REPO_NAME = "leetcode-study";
const PR_NUMBER = 42;
const HEAD_SHA = "head-sha";
const APP_TOKEN = "fake-app-token";
const OPENAI_KEY = "fake-openai-key";

const PATTERN_MARKER = "<!-- dalestudy-pattern-tag -->";
const LEGACY_COMPLEXITY_MARKER = "<!-- dalestudy-complexity-analysis -->";

const PLAIN_SOURCE = "function solution() { return 0; }";

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

function failResponse(status = 500) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve({ error: "fail" }),
    text: () => Promise.resolve("fail"),
  });
}

function makeSolutionFile(
  problemName,
  username = "testuser",
  status = "added"
) {
  return {
    filename: `${problemName}/${username}.js`,
    status,
    raw_url: `https://raw.example.com/${problemName}/${username}.js`,
  };
}

function makePrData(overrides = {}) {
  return { draft: false, labels: [], ...overrides };
}

/**
 * 두 OpenAI 엔드포인트(패턴 분석 N콜 + 복잡도 분석 1콜)를 분기한다.
 * 복잡도 호출은 system_prompt 에 "시간/공간 복잡도를 분석" 이 포함되는지로 식별.
 */
function makeFetchMock({
  solutionFiles,
  rawContent = PLAIN_SOURCE,
  patternResponse = { patterns: ["Two Pointers"], description: "test" },
  complexityFiles = null,
  complexityFails = false,
  existingIssueComments = [],
  postCapture = null,
} = {}) {
  return vi.fn().mockImplementation((url, opts) => {
    const urlStr = typeof url === "string" ? url : url.url;
    const method = opts?.method ?? "GET";

    if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
      return okJson(solutionFiles);
    }

    if (urlStr.startsWith("https://raw.example.com/")) {
      return okText(rawContent);
    }

    if (urlStr.includes("openai.com/v1/chat/completions")) {
      const body = JSON.parse(opts.body);
      const isComplexity = body.messages[0].content.includes(
        "시간/공간 복잡도를 분석"
      );
      if (isComplexity) {
        if (complexityFails) return failResponse(500);
        const files = complexityFiles ?? [];
        return okJson({
          choices: [
            { message: { content: JSON.stringify({ files }) } },
          ],
        });
      }
      return okJson({
        choices: [
          { message: { content: JSON.stringify(patternResponse) } },
        ],
      });
    }

    if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "POST") {
      const parsed = JSON.parse(opts.body);
      if (postCapture) postCapture.push({ path: parsed.path, body: parsed.body });
      return okJson({ id: 999 });
    }

    if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
      return okJson(existingIssueComments);
    }

    if (urlStr.includes("/issues/comments/") && method === "DELETE") {
      return okJson({});
    }

    throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
  });
}

describe("tagPatterns — skip 조건", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draft PR 은 skip 한다", async () => {
    globalThis.fetch = vi.fn();

    const result = await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData({ draft: true }),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "draft" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("maintenance 라벨이 있으면 skip 한다", async () => {
    globalThis.fetch = vi.fn();

    const result = await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData({ labels: [{ name: "maintenance" }] }),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "maintenance" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("솔루션 파일이 없으면 skip 한다", async () => {
    globalThis.fetch = makeFetchMock({
      solutionFiles: [
        { filename: "README.md", status: "modified", raw_url: "x" },
      ],
    });

    const result = await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "no-solution-files" });
  });
});

describe("tagPatterns — 합본 댓글 (패턴 + 복잡도)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("패턴과 복잡도가 모두 성공하면 합본 댓글에 두 섹션이 모두 들어간다", async () => {
    const posts = [];
    globalThis.fetch = makeFetchMock({
      solutionFiles: [makeSolutionFile("two-sum")],
      complexityFiles: [
        {
          problemName: "two-sum",
          solutions: [
            {
              name: "solution",
              headerLine: 1,
              actualTime: "O(n)",
              actualSpace: "O(1)",
              feedback: "정확합니다!",
              suggestion: "현재 구현이 적절해 보입니다.",
            },
          ],
        },
      ],
      postCapture: posts,
    });

    const result = await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result.tagged).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("two-sum/testuser.js");
    expect(posts[0].body).toContain(PATTERN_MARKER);
    expect(posts[0].body).toContain("### 🏷️ 알고리즘 패턴 분석");
    expect(posts[0].body).toContain("### 📊 시간/공간 복잡도 분석");
    expect(posts[0].body).toContain("정확합니다!");
    // 합본 댓글에는 LEGACY_COMPLEXITY_MARKER 가 들어가지 않는다
    expect(posts[0].body).not.toContain(LEGACY_COMPLEXITY_MARKER);
  });

  it("분석 대상 코드를 첨부한다", async () => {
    const posts = [];
    globalThis.fetch = makeFetchMock({
      solutionFiles: [makeSolutionFile("two-sum")],
      postCapture: posts,
    });

    await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    const body = posts[0].body;

    expect(body).toContain(`<details>
<summary>two-sum/testuser.js</summary>

\`\`\`js
${PLAIN_SOURCE}
\`\`\`

</details>`);
  });

  it("복잡도 OpenAI 가 실패해도 패턴 댓글은 정상 작성된다", async () => {
    const posts = [];
    globalThis.fetch = makeFetchMock({
      solutionFiles: [makeSolutionFile("two-sum")],
      complexityFails: true,
      postCapture: posts,
    });

    const result = await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result.tagged).toBe(1);
    expect(posts[0].body).toContain("### 🏷️ 알고리즘 패턴 분석");
    expect(posts[0].body).not.toContain("### 📊 시간/공간 복잡도 분석");
  });

  it("복잡도 결과가 비어 있으면 복잡도 섹션 없이 패턴만 게시된다", async () => {
    const posts = [];
    globalThis.fetch = makeFetchMock({
      solutionFiles: [makeSolutionFile("two-sum")],
      complexityFiles: [], // OpenAI 가 빈 files 반환
      postCapture: posts,
    });

    const result = await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result.tagged).toBe(1);
    expect(posts[0].body).toContain("### 🏷️ 알고리즘 패턴 분석");
    expect(posts[0].body).not.toContain("### 📊 시간/공간 복잡도 분석");
  });

  it("여러 파일 — 각자 자기 problemName 의 복잡도 결과가 매핑된다", async () => {
    const posts = [];
    globalThis.fetch = makeFetchMock({
      solutionFiles: [
        makeSolutionFile("two-sum"),
        makeSolutionFile("valid-parentheses"),
      ],
      complexityFiles: [
        {
          problemName: "two-sum",
          solutions: [
            {
              name: "twoSum",
              headerLine: 1,
              actualTime: "O(n)",
              actualSpace: "O(n)",
              feedback: "two-sum 피드백",
              suggestion: "",
            },
          ],
        },
        {
          problemName: "valid-parentheses",
          solutions: [
            {
              name: "isValid",
              headerLine: 1,
              actualTime: "O(n)",
              actualSpace: "O(n)",
              feedback: "valid-parentheses 피드백",
              suggestion: "",
            },
          ],
        },
      ],
      postCapture: posts,
    });

    await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(posts).toHaveLength(2);

    const twoSumPost = posts.find((p) => p.path === "two-sum/testuser.js");
    const validPost = posts.find(
      (p) => p.path === "valid-parentheses/testuser.js"
    );

    expect(twoSumPost.body).toContain("two-sum 피드백");
    expect(twoSumPost.body).not.toContain("valid-parentheses 피드백");
    expect(validPost.body).toContain("valid-parentheses 피드백");
    expect(validPost.body).not.toContain("two-sum 피드백");
  });
});

describe("tagPatterns — 레거시 단독 복잡도 issue comment 마이그레이션", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LEGACY_COMPLEXITY_MARKER 가 있는 Bot issue comment 를 삭제한다", async () => {
    let deletedId = null;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(PLAIN_SOURCE);
      }
      if (urlStr.includes("openai.com")) {
        const body = JSON.parse(opts.body);
        const isComplexity = body.messages[0].content.includes(
          "시간/공간 복잡도를 분석"
        );
        if (isComplexity) {
          return okJson({
            choices: [
              { message: { content: JSON.stringify({ files: [] }) } },
            ],
          });
        }
        return okJson({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  patterns: ["Two Pointers"],
                  description: "x",
                }),
              },
            },
          ],
        });
      }
      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 1 });
      }
      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([
          {
            id: 777,
            user: { type: "Bot" },
            body: `${LEGACY_COMPLEXITY_MARKER}\n구버전 댓글`,
          },
        ]);
      }
      if (urlStr.includes("/issues/comments/777") && method === "DELETE") {
        deletedId = 777;
        return okJson({});
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(deletedId).toBe(777);
  });

  it("레거시 댓글이 없으면 DELETE 호출 없음", async () => {
    let deleteCalled = false;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(PLAIN_SOURCE);
      }
      if (urlStr.includes("openai.com")) {
        const body = JSON.parse(opts.body);
        const isComplexity = body.messages[0].content.includes(
          "시간/공간 복잡도를 분석"
        );
        if (isComplexity) {
          return okJson({
            choices: [
              { message: { content: JSON.stringify({ files: [] }) } },
            ],
          });
        }
        return okJson({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  patterns: [],
                  description: "",
                }),
              },
            },
          ],
        });
      }
      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([]);
      }
      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 1 });
      }
      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([]);
      }
      if (urlStr.includes("/issues/comments/") && method === "DELETE") {
        deleteCalled = true;
        return okJson({});
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(deleteCalled).toBe(false);
  });

  it("Bot 이 아닌 사용자가 LEGACY_COMPLEXITY_MARKER 를 포함한 댓글은 건드리지 않는다", async () => {
    let deleteCalled = false;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(PLAIN_SOURCE);
      }
      if (urlStr.includes("openai.com")) {
        const body = JSON.parse(opts.body);
        const isComplexity = body.messages[0].content.includes(
          "시간/공간 복잡도를 분석"
        );
        if (isComplexity) {
          return okJson({
            choices: [
              { message: { content: JSON.stringify({ files: [] }) } },
            ],
          });
        }
        return okJson({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  patterns: [],
                  description: "",
                }),
              },
            },
          ],
        });
      }
      if (urlStr.includes(`/pulls/${PR_NUMBER}/comments`) && method === "POST") {
        return okJson({ id: 1 });
      }
      if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
        return okJson([
          {
            id: 555,
            user: { type: "User" },
            body: `${LEGACY_COMPLEXITY_MARKER}\n수동 작성 인용`,
          },
        ]);
      }
      if (urlStr.includes("/issues/comments/") && method === "DELETE") {
        deleteCalled = true;
        return okJson({});
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(deleteCalled).toBe(false);
  });
});

describe("tagPatterns — 분석 대상 파일 선택", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "변경 파일 목록이 전달되지 않으면 PR의 모든 풀이 파일을 분석한다",
      {
        solutionFiles: [
          makeSolutionFile("a", "user"),
          makeSolutionFile("b", "user"),
        ],
        changedFilenames: null,
        expectedFilenames: ["a/user.js", "b/user.js"],
      },
    ],
    [
      "변경 파일 목록이 있으면 해당 파일만 분석한다",
      {
        solutionFiles: [
          makeSolutionFile("a", "user"),
          makeSolutionFile("b", "user"),
        ],
        changedFilenames: ["b/user.js"],
        expectedFilenames: ["b/user.js"],
      },
    ],
    [
      "변경 파일 중 삭제된 파일은 분석하지 않는다",
      {
        solutionFiles: [makeSolutionFile("a", "user", "removed")],
        changedFilenames: ["a/user.js"],
        expectedFilenames: [],
      },
    ],
  ])("%s", async (_, testCase) => {
    const {
      solutionFiles,
      changedFilenames,
      expectedFilenames,
    } = testCase;
    const posts = [];
    globalThis.fetch = makeFetchMock({
      solutionFiles,
      postCapture: posts,
    });

    await tagPatterns(
      REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
      makePrData(),
      APP_TOKEN, OPENAI_KEY,
      changedFilenames
    );

    expect(posts.map(({ path }) => path)).toEqual(expectedFilenames);
  });
});
