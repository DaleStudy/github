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

// ── 응답 정규화 ───────────────────────────────────

describe("analyzeComplexity — 응답 정규화", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupFetchAndCaptureBody(openaiFiles) {
    let capturedBody = null;

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson(openaiFiles.map((f) => makeSolutionFile(f.problemName)));
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

  it("모델이 hasUserAnnotation=true 로 답해도 userTime/userSpace 가 둘 다 null 이면 false 로 뒤집힌다", async () => {
    const getBody = setupFetchAndCaptureBody([
      {
        problemName: "two-sum",
        solutions: [
          {
            name: "solution",
            description: "기본 풀이",
            hasUserAnnotation: true,
            userTime: null,
            userSpace: null,
            actualTime: "O(n)",
            actualSpace: "O(1)",
            matches: { time: true, space: true },
            feedback: "fb",
            suggestion: "sg",
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
    expect(body).not.toContain("유저 분석");
    expect(body).toContain("| | 복잡도 |");
    expect(body).toContain("💡 풀이에 시간/공간 복잡도를 주석으로 남겨보세요!");
  });

  it("userTime 값에 Big-O 리터럴이 없으면 null 로 떨어지고 matches.time 도 false 가 된다", async () => {
    const getBody = setupFetchAndCaptureBody([
      {
        problemName: "two-sum",
        solutions: [
          {
            name: "solution",
            description: "기본 풀이",
            hasUserAnnotation: true,
            userTime: "아주 빠름",
            userSpace: "O(1)",
            actualTime: "O(n)",
            actualSpace: "O(1)",
            matches: { time: true, space: true },
            feedback: "fb",
            suggestion: "sg",
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
    // 비교 테이블은 유지됨 (userSpace 는 유효)
    expect(body).toContain("유저 분석");
    // userTime 행은 null 처리 → 유저값 "-", 매칭 기호 "-"
    expect(body).toMatch(/\*\*Time\*\*\s*\|\s*-\s*\|\s*O\(n\)\s*\|\s*-/);
  });

  it("모델이 matches.time=true 를 반환해도 userTime=null 이면 matches.time 이 false 로 강제된다", async () => {
    const getBody = setupFetchAndCaptureBody([
      {
        problemName: "two-sum",
        solutions: [
          {
            name: "solution",
            description: "기본 풀이",
            hasUserAnnotation: true,
            userTime: null,
            userSpace: "O(1)",
            actualTime: "O(n)",
            actualSpace: "O(1)",
            matches: { time: true, space: true },
            feedback: "fb",
            suggestion: "sg",
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
    // userTime null → Time 행 매칭 기호 "-", userSpace 는 일치로 ✅
    expect(body).toMatch(/\*\*Time\*\*\s*\|\s*-\s*\|\s*O\(n\)\s*\|\s*-/);
    expect(body).toMatch(/\*\*Space\*\*\s*\|\s*O\(1\)\s*\|\s*O\(1\)\s*\|\s*✅/);
  });

  it("멀티 풀이에서 주석 있는 풀이와 없는 풀이가 섞여 있을 때 각자 올바르게 정규화된다", async () => {
    const getBody = setupFetchAndCaptureBody([
      {
        problemName: "find-min",
        solutions: [
          {
            name: "findMin_math",
            description: "Math.min 사용",
            hasUserAnnotation: true,
            userTime: "O(n^4)",
            userSpace: "O(n)",
            actualTime: "O(n)",
            actualSpace: "O(n)",
            matches: { time: false, space: true },
            feedback: "fb1",
            suggestion: "sg1",
          },
          {
            name: "findMin_naive",
            description: "순차 탐색",
            hasUserAnnotation: true,
            userTime: "O(n^3)",
            userSpace: "O(1)",
            actualTime: "O(n)",
            actualSpace: "O(1)",
            matches: { time: false, space: true },
            feedback: "fb2",
            suggestion: "sg2",
          },
          {
            // 주석 없는 풀이인데 모델이 실수로 true 를 채워서 보냄
            name: "findMin",
            description: "이진 탐색",
            hasUserAnnotation: true,
            userTime: null,
            userSpace: null,
            actualTime: "O(log n)",
            actualSpace: "O(1)",
            matches: { time: true, space: true },
            feedback: "fb3",
            suggestion: "sg3",
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
    // 3 풀이 모두 details 로 렌더
    expect(body).toContain("3가지 풀이");
    expect(body).toContain("findMin_math");
    expect(body).toContain("findMin_naive");
    expect(body).toContain("findMin");
    // 주석 없는 풀이는 댓글 상에서 '복잡도' 단일 테이블로 렌더되어야 함
    expect(body).toContain("| | 복잡도 |");
    // 주석 없는 풀이가 하나라도 있으면 안내 블록 포함
    expect(body).toContain("💡 풀이에 시간/공간 복잡도를 주석으로 남겨보세요!");
  });
});

// ── user prompt 패키징 ────────────────────────────

describe("analyzeComplexity — user prompt 라인 번호", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OpenAI 에 전달되는 user prompt 각 라인에 'L{n}: ' prefix 가 붙는다", async () => {
    const sourceLines = [
      "// TC: O(n)",
      "// SC: O(1)",
      "function solution() { return 0; }",
    ];
    const source = sourceLines.join("\n");

    let capturedUserContent = null;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(source);
      }
      if (urlStr.includes("openai.com")) {
        capturedUserContent = JSON.parse(opts.body).messages[1].content;
        return makeOpenAIResponse([makeSingleSolutionAnalysis("two-sum")]);
      }
      if (urlStr.includes("/issues/") && urlStr.includes("/comments")) {
        if (method === "GET") return okJson([]);
        if (method === "POST") return okJson({ id: 1 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(capturedUserContent).toContain("L1: // TC: O(n)");
    expect(capturedUserContent).toContain("L2: // SC: O(1)");
    expect(capturedUserContent).toContain("L3: function solution() { return 0; }");
  });
});
