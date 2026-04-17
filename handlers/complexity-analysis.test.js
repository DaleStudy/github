import { describe, it, expect, vi, beforeEach } from "bun:test";

vi.mock("../utils/github.js", () => ({
  getGitHubHeaders: vi.fn((token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "DaleStudy-GitHub-App",
  })),
}));

import { analyzeComplexity } from "./complexity-analysis.js";

const REPO_OWNER = "DaleStudy";
const REPO_NAME = "leetcode-study";
const PR_NUMBER = 42;
const APP_TOKEN = "fake-token";
const OPENAI_KEY = "fake-openai-key";

const COMMENT_MARKER = "<!-- dalestudy-complexity-analysis -->";

function makePrData(overrides = {}) {
  return { draft: false, labels: [], ...overrides };
}

function makeSolutionFile(problemName, username = "testuser", status = "added") {
  return {
    filename: `${problemName}/${username}.js`,
    status,
    raw_url: `https://raw.example.com/${problemName}/${username}.js`,
  };
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

function failResponse(status = 500) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve({ error: "fail" }),
    text: () => Promise.resolve("fail"),
  });
}

function makeOpenAIResponse(files) {
  return okJson({
    choices: [
      {
        message: {
          content: JSON.stringify({ files }),
        },
      },
    ],
  });
}

function makeSingleSolutionAnalysis(problemName, overrides = {}) {
  return {
    problemName,
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
        ...overrides,
      },
    ],
  };
}

// ── skip 조건 ─────────────────────────────────────

describe("analyzeComplexity — skip 조건", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draft PR 은 skip 한다", async () => {
    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData({ draft: true }),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "draft" });
  });

  it("maintenance 라벨이 있으면 skip 한다", async () => {
    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData({ labels: [{ name: "maintenance" }] }),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "maintenance" });
  });

  it("솔루션 파일이 없으면 skip 한다", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([
          { filename: "README.md", status: "modified", raw_url: "https://raw.example.com/README.md" },
        ]);
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "no-solution-files" });
  });

  it("deleted 상태 파일은 솔루션으로 취급하지 않는다", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([
          { filename: "two-sum/testuser.js", status: "deleted", raw_url: "https://raw.example.com/two-sum/testuser.js" },
        ]);
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "no-solution-files" });
  });

  it("솔루션 경로 패턴에 맞지 않는 파일은 무시한다", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([
          { filename: "deep/nested/path/file.js", status: "added", raw_url: "https://raw.example.com/a" },
          { filename: "noextension", status: "added", raw_url: "https://raw.example.com/b" },
        ]);
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "no-solution-files" });
  });

  it("모든 파일 다운로드가 실패하면 skip 한다", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return failResponse(404);
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result).toEqual({ skipped: "all-downloads-failed" });
  });
});

// ── OpenAI 응답 파싱 ──────────────────────────────

describe("analyzeComplexity — OpenAI 응답 파싱", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupFetchWithOpenAI(openaiResponse) {
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() { return 0; }");
      }
      if (urlStr.includes("openai.com")) {
        return openaiResponse;
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments")) {
        if (method === "GET") return okJson([]);
        if (method === "POST") return okJson({ id: 1 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });
  }

  it("정상적인 OpenAI 응답을 파싱하여 댓글을 작성한다", async () => {
    setupFetchWithOpenAI(
      makeOpenAIResponse([makeSingleSolutionAnalysis("two-sum")])
    );

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result.analyzed).toBe(1);
    expect(result.total).toBe(1);
  });

  it("OpenAI API 호출이 실패하면 에러를 throw 한다", async () => {
    setupFetchWithOpenAI(failResponse(429));

    await expect(
      analyzeComplexity(
        REPO_OWNER, REPO_NAME, PR_NUMBER,
        makePrData(),
        APP_TOKEN, OPENAI_KEY
      )
    ).rejects.toThrow("OpenAI API error");
  });

  it("OpenAI 가 빈 choices 를 반환하면 에러를 throw 한다", async () => {
    setupFetchWithOpenAI(okJson({ choices: [{ message: {} }] }));

    await expect(
      analyzeComplexity(
        REPO_OWNER, REPO_NAME, PR_NUMBER,
        makePrData(),
        APP_TOKEN, OPENAI_KEY
      )
    ).rejects.toThrow("Empty response from OpenAI");
  });

  it("OpenAI 가 잘못된 JSON 을 반환하면 에러를 throw 한다", async () => {
    setupFetchWithOpenAI(
      okJson({ choices: [{ message: { content: "not json {{{" } }] })
    );

    await expect(
      analyzeComplexity(
        REPO_OWNER, REPO_NAME, PR_NUMBER,
        makePrData(),
        APP_TOKEN, OPENAI_KEY
      )
    ).rejects.toThrow("OpenAI returned invalid JSON");
  });

  it("OpenAI 응답에 누락된 필드가 있으면 기본값으로 대체한다", async () => {
    setupFetchWithOpenAI(
      okJson({
        choices: [
          {
            message: {
              content: JSON.stringify({
                files: [
                  {
                    problemName: "two-sum",
                    solutions: [
                      {
                        // name, description, feedback, suggestion 누락
                        actualTime: "O(n)",
                        actualSpace: "O(1)",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      })
    );

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result.analyzed).toBe(1);

    // 댓글이 POST 되었는지 확인
    const postCall = globalThis.fetch.mock.calls.find(
      ([url, opts]) => opts?.method === "POST" && url.includes("/comments")
    );
    expect(postCall).toBeDefined();
  });

  it("OpenAI 응답의 files 가 배열이 아니면 빈 결과로 처리한다", async () => {
    setupFetchWithOpenAI(
      okJson({
        choices: [
          { message: { content: JSON.stringify({ files: "not-array" }) } },
        ],
      })
    );

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    // files 매핑 실패 → 빈 solutions → 여전히 댓글은 작성 (분석 결과 없음 표시)
    expect(result.analyzed).toBe(0);
    expect(result.total).toBe(1);
  });
});

// ── 댓글 포맷 ─────────────────────────────────────

describe("analyzeComplexity — 댓글 포맷", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupFetchAndCapture(openaiFiles) {
    let capturedBody = null;

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        const files = openaiFiles.map((f) => makeSolutionFile(f.problemName));
        return okJson(files);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() {}");
      }
      if (urlStr.includes("openai.com")) {
        return makeOpenAIResponse(openaiFiles);
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments")) {
        if (method === "GET") return okJson([]);
        if (method === "POST") {
          capturedBody = JSON.parse(opts.body).body;
          return okJson({ id: 1 });
        }
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    return () => capturedBody;
  }

  it("단일 풀이 + 유저 주석 있음 → 비교 테이블 포맷", async () => {
    const getBody = setupFetchAndCapture([
      makeSingleSolutionAnalysis("two-sum"),
    ]);

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    const body = getBody();
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("유저 분석");
    expect(body).toContain("실제 분석");
    expect(body).toContain("✅");
    expect(body).not.toContain("<details>");
  });

  it("단일 풀이 + 유저 주석 없음 → 복잡도만 표시 + 주석 권장 안내", async () => {
    const getBody = setupFetchAndCapture([
      makeSingleSolutionAnalysis("two-sum", {
        hasUserAnnotation: false,
        userTime: null,
        userSpace: null,
        matches: { time: false, space: false },
      }),
    ]);

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    const body = getBody();
    expect(body).toContain("| | 복잡도 |");
    expect(body).not.toContain("유저 분석");
    expect(body).toContain("💡 풀이에 시간/공간 복잡도를 주석으로 남겨보세요!");
  });

  it("불일치 시 ❌ 표시", async () => {
    const getBody = setupFetchAndCapture([
      makeSingleSolutionAnalysis("two-sum", {
        userTime: "O(1)",
        actualTime: "O(n)",
        matches: { time: false, space: true },
      }),
    ]);

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    const body = getBody();
    expect(body).toContain("❌");
    expect(body).toContain("✅");
  });

  it("멀티 풀이 → details 접기 포맷", async () => {
    const getBody = setupFetchAndCapture([
      {
        problemName: "two-sum",
        solutions: [
          {
            name: "twoSum_bruteForce",
            description: "brute force",
            hasUserAnnotation: true,
            userTime: "O(n²)",
            userSpace: "O(1)",
            actualTime: "O(n²)",
            actualSpace: "O(1)",
            matches: { time: true, space: true },
            feedback: "정확합니다!",
            suggestion: "HashMap 으로 O(n) 가능",
          },
          {
            name: "twoSum",
            description: "HashMap",
            hasUserAnnotation: true,
            userTime: "O(n)",
            userSpace: "O(n)",
            actualTime: "O(n)",
            actualSpace: "O(n)",
            matches: { time: true, space: true },
            feedback: "최적 풀이!",
            suggestion: "현재 구현이 적절해 보입니다.",
          },
        ],
      },
    ]);

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    const body = getBody();
    expect(body).toContain("<details>");
    expect(body).toContain("</details>");
    expect(body).toContain("2가지 풀이");
    expect(body).toContain("twoSum_bruteForce");
    expect(body).toContain("twoSum");
  });

  it("여러 문제 파일 → 각 문제별 섹션으로 출력한다", async () => {
    const files = [
      makeSingleSolutionAnalysis("two-sum"),
      makeSingleSolutionAnalysis("valid-parentheses"),
    ];

    let capturedBody = null;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([
          makeSolutionFile("two-sum"),
          makeSolutionFile("valid-parentheses"),
        ]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() {}");
      }
      if (urlStr.includes("openai.com")) {
        return makeOpenAIResponse(files);
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments")) {
        if (method === "GET") return okJson([]);
        if (method === "POST") {
          capturedBody = JSON.parse(opts.body).body;
          return okJson({ id: 1 });
        }
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result.analyzed).toBe(2);
    expect(capturedBody).toContain("### two-sum");
    expect(capturedBody).toContain("### valid-parentheses");
  });
});

// ── 댓글 upsert ──────────────────────────────────

describe("analyzeComplexity — 댓글 upsert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupWithExistingComment(existingComments) {
    let lastMethod = null;

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() {}");
      }
      if (urlStr.includes("openai.com")) {
        return makeOpenAIResponse([makeSingleSolutionAnalysis("two-sum")]);
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments") && method === "GET") {
        return okJson(existingComments);
      }
      if (method === "POST" && urlStr.includes("/comments")) {
        lastMethod = "POST";
        return okJson({ id: 999 });
      }
      if (method === "PATCH" && urlStr.includes("/comments/")) {
        lastMethod = "PATCH";
        return okJson({ id: 123 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    return () => lastMethod;
  }

  it("기존 복잡도 댓글이 없으면 POST 로 새 댓글을 작성한다", async () => {
    const getMethod = setupWithExistingComment([]);

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(getMethod()).toBe("POST");
  });

  it("기존 복잡도 댓글이 있으면 PATCH 로 업데이트한다", async () => {
    const getMethod = setupWithExistingComment([
      {
        id: 123,
        user: { type: "Bot" },
        body: `${COMMENT_MARKER}\n이전 분석 내용`,
      },
    ]);

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(getMethod()).toBe("PATCH");
  });

  it("Bot 이 아닌 사용자의 마커 댓글은 기존 댓글로 인식하지 않는다", async () => {
    const getMethod = setupWithExistingComment([
      {
        id: 456,
        user: { type: "User" },
        body: `${COMMENT_MARKER}\n수동 작성`,
      },
    ]);

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(getMethod()).toBe("POST");
  });
});

// ── 파일 크기 제한 ────────────────────────────────

describe("analyzeComplexity — 파일 크기 제한", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("MAX_TOTAL_SIZE 를 초과하면 남은 파일을 건너뛴다", async () => {
    // MAX_FILE_SIZE=15000 으로 잘리므로 각 파일 15000 바이트
    // 15000 × 4 = 60000 = MAX_TOTAL_SIZE → 4개 통과
    // 15000 × 5 = 75000 > MAX_TOTAL_SIZE → 5번째 스킵
    const bigContent = "x".repeat(20000); // → 15000 으로 잘림
    const files = Array.from({ length: 5 }, (_, i) => makeSolutionFile(`problem-${i}`));

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson(files);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(bigContent);
      }
      if (urlStr.includes("openai.com")) {
        return makeOpenAIResponse(
          [0, 1, 2, 3].map((i) => makeSingleSolutionAnalysis(`problem-${i}`))
        );
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments")) {
        if (method === "GET") return okJson([]);
        if (method === "POST") return okJson({ id: 1 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    // 4개만 분석됨 (5번째는 다운로드 후 총합 초과로 스킵)
    expect(result.total).toBe(4);
  });

  it("개별 파일이 MAX_FILE_SIZE 를 초과하면 잘라서 사용한다", async () => {
    // 16000 바이트 파일 → MAX_FILE_SIZE(15000) 으로 잘림
    const hugeContent = "y".repeat(16000);

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(hugeContent);
      }
      if (urlStr.includes("openai.com")) {
        // OpenAI 에 전달된 content 길이 검증
        const body = JSON.parse(opts.body);
        const userContent = body.messages[1].content;
        // 잘린 content 가 15000 이하여야 함
        expect(userContent.length).toBeLessThanOrEqual(16000 + 200); // 마커+코드블록 오버헤드 포함
        return makeOpenAIResponse([makeSingleSolutionAnalysis("two-sum")]);
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments")) {
        if (method === "GET") return okJson([]);
        if (method === "POST") return okJson({ id: 1 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    const result = await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(result.analyzed).toBe(1);
  });
});

// ── PR files API 실패 ─────────────────────────────

describe("analyzeComplexity — 에러 처리", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PR files API 가 실패하면 에러를 throw 한다", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return failResponse(403);
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    await expect(
      analyzeComplexity(
        REPO_OWNER, REPO_NAME, PR_NUMBER,
        makePrData(),
        APP_TOKEN, OPENAI_KEY
      )
    ).rejects.toThrow("Failed to list PR files");
  });

  it("댓글 목록 조회가 실패하면 에러를 throw 한다", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText("function solution() {}");
      }
      if (urlStr.includes("openai.com")) {
        return makeOpenAIResponse([makeSingleSolutionAnalysis("two-sum")]);
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments") && method === "GET") {
        return failResponse(500);
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    await expect(
      analyzeComplexity(
        REPO_OWNER, REPO_NAME, PR_NUMBER,
        makePrData(),
        APP_TOKEN, OPENAI_KEY
      )
    ).rejects.toThrow("Failed to list comments");
  });
});
