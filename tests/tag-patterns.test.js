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

const LINK_COMMENT_MARKER = "<!-- dalestudy-ai-analysis-link -->";
const LEGACY_COMPLEXITY_MARKER = "<!-- dalestudy-complexity-analysis -->";
const MAX_FILE_CONTENT_LENGTH = 20000;
const CHECK_RUN_URL = "https://github.com/DaleStudy/leetcode-study/runs/777";

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

function makeSolutionFile(problemName, username = "testuser", status = "added") {
  return {
    filename: `${problemName}/${username}.js`,
    status,
    raw_url: `https://raw.example.com/${problemName}/${username}.js`,
  };
}

function makePrData(overrides = {}) {
  return { draft: false, labels: [], ...overrides };
}

function runTagPatterns(prData = makePrData()) {
  return tagPatterns(
    REPO_OWNER, REPO_NAME, PR_NUMBER, HEAD_SHA,
    prData,
    APP_TOKEN, OPENAI_KEY
  );
}

/**
 * 두 OpenAI 엔드포인트(패턴 분석 N콜 + 복잡도 분석 1콜)를 분기하고,
 * 쓰기 요청(POST/PATCH/DELETE)은 requests 에 모은다.
 * 복잡도 호출은 system_prompt 에 "시간/공간 복잡도를 분석" 이 포함되는지로 식별.
 */
function makeFetchMock({
  solutionFiles,
  rawContent = PLAIN_SOURCE,
  patternResponse = { patterns: ["Two Pointers"], description: "test" },
  failingPatternProblems = [],
  complexityFiles = null,
  complexityFails = false,
  checkRunFails = false,
  existingIssueComments = [],
} = {}) {
  const requests = [];
  const fetchMock = vi.fn().mockImplementation((url, opts) => {
    const urlStr = typeof url === "string" ? url : url.url;
    const method = opts?.method ?? "GET";

    if (method !== "GET" && !urlStr.includes("/openai/")) {
      requests.push({
        method,
        url: urlStr,
        body: opts.body ? JSON.parse(opts.body) : null,
      });
    }

    if (urlStr.includes(`/pulls/${PR_NUMBER}/files`)) {
      return okJson(solutionFiles);
    }

    if (urlStr.startsWith("https://raw.example.com/")) {
      return okText(rawContent);
    }

    if (urlStr.includes("/openai/chat/completions")) {
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
      const userPrompt = body.messages[1].content;
      if (failingPatternProblems.some((p) => userPrompt.includes(p))) {
        return failResponse(500);
      }
      return okJson({
        choices: [
          { message: { content: JSON.stringify(patternResponse) } },
        ],
      });
    }

    if (urlStr.endsWith("/check-runs") && method === "POST") {
      if (checkRunFails) return failResponse(403);
      return okJson({ id: 777, html_url: CHECK_RUN_URL });
    }

    if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "GET") {
      return okJson(existingIssueComments);
    }

    if (urlStr.includes(`/issues/${PR_NUMBER}/comments`) && method === "POST") {
      return okJson({ id: 500 });
    }

    if (urlStr.includes("/issues/comments/") && method === "PATCH") {
      return okJson({});
    }

    if (urlStr.includes("/issues/comments/") && method === "DELETE") {
      return okJson({});
    }

    throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
  });

  return { fetchMock, requests };
}

function setupFetch(options) {
  const { fetchMock, requests } = makeFetchMock(options);
  globalThis.fetch = fetchMock;
  return requests;
}

function findCheckRun(requests) {
  return requests.find((r) => r.url.endsWith("/check-runs"))?.body;
}

function complexityFile(problemName, feedback) {
  return {
    problemName,
    solutions: [
      {
        name: "solution",
        headerLine: 1,
        actualTime: "O(n)",
        actualSpace: "O(1)",
        feedback,
        suggestion: "현재 구현이 적절해 보입니다.",
      },
    ],
  };
}

describe("tagPatterns — skip 조건", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draft PR 은 skip 한다", async () => {
    globalThis.fetch = vi.fn();

    const result = await runTagPatterns(makePrData({ draft: true }));

    expect(result).toEqual({ skipped: "draft" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("솔루션 파일이 없으면 skip 한다", async () => {
    const requests = setupFetch({
      solutionFiles: [
        { filename: "README.md", status: "modified", raw_url: "" },
      ],
    });

    const result = await runTagPatterns();

    expect(result).toEqual({ skipped: "no-solution-files" });
    expect(requests).toHaveLength(0);
  });

  it("삭제된 파일은 분석하지 않는다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum", "testuser", "removed")],
    });

    const result = await runTagPatterns();

    expect(result).toEqual({ skipped: "no-solution-files" });
    expect(requests).toHaveLength(0);
  });
});

describe("tagPatterns — check run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PR head 커밋에 neutral 로 완료된 check run 을 만들고 리뷰 댓글은 달지 않는다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      complexityFiles: [complexityFile("two-sum", "정확합니다!")],
    });

    const result = await runTagPatterns();

    expect(result).toEqual({ analyzed: 1, checkRunUrl: CHECK_RUN_URL });

    const checkRun = findCheckRun(requests);
    expect(checkRun).toMatchObject({
      name: "AI 풀이 분석",
      head_sha: HEAD_SHA,
      status: "completed",
      conclusion: "neutral",
    });
    expect(checkRun.output.title).toBe("풀이 파일 1개 분석");
    expect(checkRun.output.summary).toContain(
      "| `two-sum/testuser.js` | Two Pointers |"
    );
    expect(checkRun.output.text).toContain("## `two-sum/testuser.js`");
    expect(checkRun.output.text).toContain("### 🏷️ 알고리즘 패턴 분석");
    expect(checkRun.output.text).toContain("### 📊 시간/공간 복잡도 분석");
    expect(checkRun.output.text).toContain("정확합니다!");

    expect(requests.some((r) => r.url.includes("/pulls/"))).toBe(false);
  });

  it("분석 대상 코드는 첨부하지 않는다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
    });

    await runTagPatterns();

    const { output } = findCheckRun(requests);
    expect(output.text).not.toContain(PLAIN_SOURCE);
    expect(output.text).not.toContain("<details>");
  });

  it.each([MAX_FILE_CONTENT_LENGTH - 1, MAX_FILE_CONTENT_LENGTH])(
    "파일 내용 길이가 제한값 이하인 경우(%i자) 생략 안내를 표시하지 않는다",
    async (contentLength) => {
      const requests = setupFetch({
        solutionFiles: [makeSolutionFile("two-sum")],
        rawContent: "a".repeat(contentLength),
      });

      await runTagPatterns();

      expect(findCheckRun(requests).output.text).not.toContain(
        "앞부분만 분석"
      );
    }
  );

  it("파일 내용 길이가 제한값을 초과하면 생략 안내를 표시한다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      rawContent: "a".repeat(MAX_FILE_CONTENT_LENGTH + 1),
    });

    await runTagPatterns();

    expect(findCheckRun(requests).output.text).toContain(
      `앞부분 ${MAX_FILE_CONTENT_LENGTH}자만 분석했습니다.`
    );
  });

  it("복잡도 OpenAI 가 실패해도 패턴 분석은 게시된다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      complexityFails: true,
    });

    const result = await runTagPatterns();

    const { output } = findCheckRun(requests);
    expect(result.analyzed).toBe(1);
    expect(output.text).toContain("### 🏷️ 알고리즘 패턴 분석");
    expect(output.text).not.toContain("### 📊 시간/공간 복잡도 분석");
  });

  it("복잡도 결과가 비어 있으면 복잡도 섹션 없이 패턴만 게시된다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      complexityFiles: [],
    });

    await runTagPatterns();

    const { output } = findCheckRun(requests);
    expect(output.text).toContain("### 🏷️ 알고리즘 패턴 분석");
    expect(output.text).not.toContain("### 📊 시간/공간 복잡도 분석");
  });

  it("한 파일의 패턴 분석이 실패해도 나머지 파일과 함께 게시한다", async () => {
    const requests = setupFetch({
      solutionFiles: [
        makeSolutionFile("two-sum"),
        makeSolutionFile("valid-parentheses"),
      ],
      failingPatternProblems: ["valid-parentheses"],
    });

    const result = await runTagPatterns();

    const { output } = findCheckRun(requests);
    expect(result.analyzed).toBe(1);
    expect(output.title).toBe("풀이 파일 2개 분석");
    expect(output.summary).toContain(
      "| `two-sum/testuser.js` | Two Pointers |"
    );
    expect(output.summary).toContain(
      "| `valid-parentheses/testuser.js` | ⚠️ 분석 실패 |"
    );
    expect(output.text).toContain("> ⚠️ 패턴 분석에 실패했습니다.");
  });

  it("여러 파일 — 각 섹션에 자기 problemName 의 복잡도 결과가 매핑된다", async () => {
    const requests = setupFetch({
      solutionFiles: [
        makeSolutionFile("two-sum"),
        makeSolutionFile("valid-parentheses"),
      ],
      complexityFiles: [
        complexityFile("two-sum", "two-sum 피드백"),
        complexityFile("valid-parentheses", "valid-parentheses 피드백"),
      ],
    });

    await runTagPatterns();

    const [twoSumSection, validSection] = findCheckRun(requests)
      .output.text.split("## `")
      .slice(1);

    expect(twoSumSection).toContain("two-sum 피드백");
    expect(twoSumSection).not.toContain("valid-parentheses 피드백");
    expect(validSection).toContain("valid-parentheses 피드백");
    expect(validSection).not.toContain("two-sum 피드백");
  });

  it("check run 생성이 실패하면 throw 하고 링크 댓글은 달지 않는다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      checkRunFails: true,
    });

    await expect(runTagPatterns()).rejects.toThrow(
      "Failed to create check run: 403"
    );
    expect(requests.some((r) => r.url.includes("/issues/"))).toBe(false);
  });
});

describe("tagPatterns — 대화 탭 링크 댓글", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("링크 댓글이 없으면 check run 링크를 담아 새로 단다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
    });

    await runTagPatterns();

    const post = requests.find(
      (r) => r.method === "POST" && r.url.includes(`/issues/${PR_NUMBER}/comments`)
    );
    expect(post.body.body).toContain(LINK_COMMENT_MARKER);
    expect(post.body.body).toContain(`[Checks 탭](${CHECK_RUN_URL})`);
  });

  it("봇이 단 링크 댓글이 있으면 새로 달지 않고 그 댓글을 고친다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      existingIssueComments: [
        {
          id: 321,
          user: { type: "Bot" },
          body: `${LINK_COMMENT_MARKER}\n이전 링크`,
        },
      ],
    });

    await runTagPatterns();

    const commentWrites = requests.filter((r) => r.url.includes("/issues/"));
    expect(commentWrites).toHaveLength(1);
    expect(commentWrites[0].method).toBe("PATCH");
    expect(commentWrites[0].url).toContain("/issues/comments/321");
    expect(commentWrites[0].body.body).toContain(CHECK_RUN_URL);
  });

  it("사람이 마커를 포함해 단 댓글은 링크 댓글로 보지 않는다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      existingIssueComments: [
        {
          id: 321,
          user: { type: "User" },
          body: `${LINK_COMMENT_MARKER}\n복사한 댓글`,
        },
      ],
    });

    await runTagPatterns();

    const commentWrites = requests.filter((r) => r.url.includes("/issues/"));
    expect(commentWrites).toHaveLength(1);
    expect(commentWrites[0].method).toBe("POST");
  });
});

describe("tagPatterns — 레거시 단독 복잡도 issue comment 마이그레이션", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function deletes(requests) {
    return requests.filter((r) => r.method === "DELETE");
  }

  it("LEGACY_COMPLEXITY_MARKER 가 있는 Bot issue comment 를 삭제한다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      existingIssueComments: [
        {
          id: 1234,
          user: { type: "Bot" },
          body: `${LEGACY_COMPLEXITY_MARKER}\n레거시`,
        },
      ],
    });

    await runTagPatterns();

    expect(deletes(requests)).toHaveLength(1);
    expect(deletes(requests)[0].url).toContain("/issues/comments/1234");
  });

  it("레거시 댓글이 없으면 DELETE 호출 없음", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
    });

    await runTagPatterns();

    expect(deletes(requests)).toHaveLength(0);
  });

  it("Bot 이 아닌 사용자가 LEGACY_COMPLEXITY_MARKER 를 포함한 댓글은 건드리지 않는다", async () => {
    const requests = setupFetch({
      solutionFiles: [makeSolutionFile("two-sum")],
      existingIssueComments: [
        {
          id: 1234,
          user: { type: "User" },
          body: `${LEGACY_COMPLEXITY_MARKER}\n사람이 쓴 댓글`,
        },
      ],
    });

    await runTagPatterns();

    expect(deletes(requests)).toHaveLength(0);
  });
});
