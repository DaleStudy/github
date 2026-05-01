import { describe, it, expect, vi, beforeEach } from "bun:test";

vi.mock("../utils/github.js", () => ({
  getGitHubHeaders: vi.fn((token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "DaleStudy-GitHub-App",
  })),
}));

import {
  analyzeComplexity,
  isComplexityCommentLine,
  stripComplexityComments,
  extractBigO,
  extractUserAnnotations,
  bigOEquals,
  cleanBigO,
  composeSolution,
} from "./complexity-analysis.js";

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

/**
 * 모델 응답 스키마 v4: name, headerLine, description, actualTime, actualSpace,
 * feedback, suggestion 만 사용. user-* / matches 는 코드가 source 에서 계산한다.
 */
function makeSingleSolutionAnalysis(problemName, overrides = {}) {
  return {
    problemName,
    solutions: [
      {
        name: "solution",
        headerLine: 1,
        description: "기본 풀이",
        actualTime: "O(n)",
        actualSpace: "O(1)",
        feedback: "한 번 순회하므로 O(n)입니다.",
        suggestion: "현재 구현이 적절해 보입니다.",
        ...overrides,
      },
    ],
  };
}

// 기본 솔루션 소스: 헤더가 L1 (// TC: O(n) / // SC: O(1) 주석 없음)
const PLAIN_SOURCE = "function solution() { return 0; }";

// 사용자 주석이 헤더 위에 있는 소스 (L1 = TC, L2 = SC, L3 = function)
const ANNOTATED_SOURCE = `// TC: O(n)
// SC: O(1)
function solution() { return 0; }`;

// ── 단위 테스트: 사용자 주석 처리 ─────────────────

describe("isComplexityCommentLine", () => {
  it("// TC: O(n) 같은 단일 라인 시간복잡도 주석을 인식한다", () => {
    expect(isComplexityCommentLine("// TC: O(n)")).toBe(true);
    expect(isComplexityCommentLine("// tc: O(n^4)")).toBe(true);
    expect(isComplexityCommentLine("# 시간 복잡도: O(n log n)")).toBe(true);
    expect(isComplexityCommentLine("# 시간복잡도: O(n)")).toBe(true);
    expect(isComplexityCommentLine("// Time: O(n)")).toBe(true);
  });

  it("공간복잡도 주석도 인식한다", () => {
    expect(isComplexityCommentLine("// SC: O(1)")).toBe(true);
    expect(isComplexityCommentLine("// sc: O(n)")).toBe(true);
    expect(isComplexityCommentLine("# 공간 복잡도: O(n)")).toBe(true);
    expect(isComplexityCommentLine("// Space: O(1)")).toBe(true);
  });

  it("키워드만 있고 Big-O 가 없으면 false", () => {
    expect(isComplexityCommentLine("// Time to compute is short")).toBe(false);
    expect(isComplexityCommentLine("// 시간 복잡도 분석")).toBe(false);
  });

  it("Big-O 만 있고 키워드가 없으면 false", () => {
    expect(isComplexityCommentLine("// 목표: O(n) 으로 줄이기")).toBe(false);
    expect(isComplexityCommentLine("// 인접 리스트 생성")).toBe(false);
  });

  it("주석이 아닌 코드 라인은 false", () => {
    expect(isComplexityCommentLine("function solution() {}")).toBe(false);
    expect(isComplexityCommentLine("const x = 1; // tc: O(n)")).toBe(false);
  });

  it("한국어 부연 설명이 같은 줄에 있어도 인식한다", () => {
    expect(
      isComplexityCommentLine(
        "// sc: 잘 몰랐는데 모든 요소를 함수 인자로 풀어 콜스택에 올려 O(n)이 된다고 함"
      )
    ).toBe(true);
  });
});

describe("stripComplexityComments", () => {
  it("복잡도 주석 라인을 빈 라인으로 치환하고 라인 수는 유지한다", () => {
    const src = `// TC: O(n)
// SC: O(1)
function solution() {}`;
    const stripped = stripComplexityComments(src);
    expect(stripped.split("\n").length).toBe(3);
    expect(stripped).toBe(`

function solution() {}`);
  });

  it("복잡도 주석이 아닌 일반 주석은 보존한다", () => {
    const src = `// math의 min을 이용
// tc: O(n^4)
function solution() {}`;
    const stripped = stripComplexityComments(src);
    expect(stripped).toBe(`// math의 min을 이용

function solution() {}`);
  });
});

describe("extractBigO", () => {
  it("기본 형태 인식", () => {
    expect(extractBigO("// TC: O(n)")).toBe("O(n)");
    expect(extractBigO("// SC: O(n^2)")).toBe("O(n^2)");
    expect(extractBigO("# 시간 복잡도: O(n log n)")).toBe("O(n log n)");
  });

  it("괄호 안 파라미터 형태도 인식", () => {
    expect(extractBigO("// O(n*m)")).toBe("O(n*m)");
    expect(extractBigO("// O(V + E)")).toBe("O(V + E)");
    expect(extractBigO("// O(2^n)")).toBe("O(2^n)");
  });

  it("Big-O 가 없으면 null", () => {
    expect(extractBigO("// 알고리즘 설명")).toBe(null);
  });
});

describe("extractUserAnnotations", () => {
  it("헤더 바로 위 주석에서 시간/공간 복잡도를 추출한다", () => {
    const src = `// tc: O(n)
// sc: O(1)
function solution() {}`;
    expect(extractUserAnnotations(src, 3)).toEqual({
      userTime: "O(n)",
      userSpace: "O(1)",
    });
  });

  it("빈 줄을 만나면 즉시 중단한다 (다른 풀이 침범 차단)", () => {
    const src = `// tc: O(n^4)
// sc: O(n)

// 빈 줄 위쪽은 무시
function solution() {}`;
    expect(extractUserAnnotations(src, 5)).toEqual({
      userTime: null,
      userSpace: null,
    });
  });

  it("멀티 풀이 — 각 풀이의 헤더 위 주석만 추출한다", () => {
    const src = `// tc: O(n^4)
// sc: O(n)
const findMin_a = (nums) => nums[0];

// tc: O(log n)
// sc: O(1)
const findMin_b = (nums) => nums[0];`;
    expect(extractUserAnnotations(src, 3)).toEqual({
      userTime: "O(n^4)",
      userSpace: "O(n)",
    });
    expect(extractUserAnnotations(src, 7)).toEqual({
      userTime: "O(log n)",
      userSpace: "O(1)",
    });
  });

  it("한국어 부연 설명이 섞여도 Big-O 부분만 추출한다", () => {
    const src = `// tc: O(n^4)
// sc: 잘 몰랐는데 모든 요소를 함수 인자로 풀어 콜스택에 올려 O(n)이 된다고 함
function solution() {}`;
    expect(extractUserAnnotations(src, 3)).toEqual({
      userTime: "O(n^4)",
      userSpace: "O(n)",
    });
  });

  it("JSDoc 만 있는 헤더 위는 모두 null", () => {
    const src = `/**
 * @param {number} n
 * @return {boolean}
 */
function solution(n) {}`;
    expect(extractUserAnnotations(src, 5)).toEqual({
      userTime: null,
      userSpace: null,
    });
  });

  it("Python # 주석 + 시간 복잡도 키워드", () => {
    const src = `# 시간 복잡도: O(V + E)
# 공간 복잡도: O(V)
class Solution:`;
    expect(extractUserAnnotations(src, 3)).toEqual({
      userTime: "O(V + E)",
      userSpace: "O(V)",
    });
  });

  it("키워드 없는 비-주석 라인 만나면 중단", () => {
    const src = `let x = 1;
// tc: O(n)
function solution() {}`;
    expect(extractUserAnnotations(src, 3)).toEqual({
      userTime: "O(n)",
      userSpace: null,
    });
  });

  it("한 종류만 있는 경우 (시간만)", () => {
    const src = `// 시간복잡도: O(n)
function solution() {}`;
    expect(extractUserAnnotations(src, 2)).toEqual({
      userTime: "O(n)",
      userSpace: null,
    });
  });

  it("headerLine 이 1 이하면 null", () => {
    expect(extractUserAnnotations("function f() {}", 1)).toEqual({
      userTime: null,
      userSpace: null,
    });
    expect(extractUserAnnotations("function f() {}", 0)).toEqual({
      userTime: null,
      userSpace: null,
    });
  });

  it("headerLine 이 정수가 아니면 null", () => {
    expect(extractUserAnnotations("// tc: O(n)\nfn();", null)).toEqual({
      userTime: null,
      userSpace: null,
    });
    expect(extractUserAnnotations("// tc: O(n)\nfn();", "2")).toEqual({
      userTime: null,
      userSpace: null,
    });
  });

  it("Python — class 선언이 외곽이고 메서드가 headerLine 이어도 클래스 위 주석을 추출한다", () => {
    const src = `from typing import Optional

# 7기 풀이
# 시간 복잡도: O(V + E)
# - 모든 노드 탐방
# 공간 복잡도: O(V)
# - memo dict 사용
class Solution:
    def cloneGraph(self, node):
        return None`;
    // headerLine=9 → "def cloneGraph" 라인. class 선언(L8)이 투명 통과되어
    // L4-7 의 주석 블록이 추출 대상이 된다.
    expect(extractUserAnnotations(src, 9)).toEqual({
      userTime: "O(V + E)",
      userSpace: "O(V)",
    });
  });

  it("Java — public class wrapper 도 통과한다", () => {
    const src = `// TC: O(n)
// SC: O(1)
public class Solution {
    public boolean hasCycle(ListNode head) {
        return false;
    }
}`;
    expect(extractUserAnnotations(src, 4)).toEqual({
      userTime: "O(n)",
      userSpace: "O(1)",
    });
  });

  it("Rust — impl wrapper 도 통과한다", () => {
    const src = `// TC: O(m * n)
// SC: O(m * n)
impl Solution {
    pub fn pacific_atlantic(heights: Vec<Vec<i32>>) -> Vec<Vec<i32>> {
        vec![]
    }
}`;
    expect(extractUserAnnotations(src, 4)).toEqual({
      userTime: "O(m * n)",
      userSpace: "O(m * n)",
    });
  });

  it("class wrapper 위쪽이 빈 줄이면 거기서 중단", () => {
    const src = `// 다른 풀이의 주석

class Solution:
    def foo(self):
        pass`;
    expect(extractUserAnnotations(src, 4)).toEqual({
      userTime: null,
      userSpace: null,
    });
  });
});

describe("cleanBigO", () => {
  it("부연 설명을 제거하고 Big-O 리터럴만 남긴다", () => {
    expect(cleanBigO("O(n) (최악)")).toBe("O(n)");
    expect(cleanBigO("O(m * 26^{k}) (최악: '.' 연속 시)")).toBe("O(m * 26^{k})");
    expect(cleanBigO("O(n^2) for n nodes")).toBe("O(n^2)");
  });

  it("이미 깨끗한 Big-O 는 그대로", () => {
    expect(cleanBigO("O(n)")).toBe("O(n)");
    expect(cleanBigO("O(n log n)")).toBe("O(n log n)");
    expect(cleanBigO("O(V + E)")).toBe("O(V + E)");
  });

  it("Big-O 가 없으면 원본 반환", () => {
    expect(cleanBigO("?")).toBe("?");
    expect(cleanBigO("unknown")).toBe("unknown");
  });

  it("타입이 string 이 아니면 원본 반환", () => {
    expect(cleanBigO(null)).toBe(null);
    expect(cleanBigO(undefined)).toBe(undefined);
  });
});

describe("bigOEquals", () => {
  it("정규화 후 같으면 true", () => {
    expect(bigOEquals("O(n log n)", "O(nlogn)")).toBe(true);
    expect(bigOEquals("O(n^2)", "O(n²)")).toBe(true);
    expect(bigOEquals("O(n^2)", "O(n**2)")).toBe(true);
    expect(bigOEquals("O(n*m)", "O(n*m)")).toBe(true);
  });

  it("서로 다른 클래스는 false", () => {
    expect(bigOEquals("O(n^2*log n)", "O(log n)")).toBe(false);
    expect(bigOEquals("O(n^4)", "O(n)")).toBe(false);
    expect(bigOEquals("O(n+m)", "O(n)")).toBe(false);
    expect(bigOEquals("O(2^n)", "O(n^2)")).toBe(false);
  });

  it("타입이 string 이 아니면 false", () => {
    expect(bigOEquals(null, "O(n)")).toBe(false);
    expect(bigOEquals("O(n)", undefined)).toBe(false);
  });
});

describe("composeSolution", () => {
  it("source 에 주석이 있으면 user 값을 추출하고 matches 를 계산한다", () => {
    const src = `// tc: O(n)
// sc: O(1)
function solution() {}`;
    const result = composeSolution(
      {
        name: "solution",
        headerLine: 3,
        description: "기본",
        actualTime: "O(n)",
        actualSpace: "O(1)",
        feedback: "fb",
        suggestion: "sg",
      },
      src
    );
    expect(result.userTime).toBe("O(n)");
    expect(result.userSpace).toBe("O(1)");
    expect(result.hasUserAnnotation).toBe(true);
    expect(result.matches).toEqual({ time: true, space: true });
  });

  it("불일치 시 matches 가 false", () => {
    const src = `// tc: O(n^4)
// sc: O(1)
function solution() {}`;
    const result = composeSolution(
      {
        name: "solution",
        headerLine: 3,
        description: "기본",
        actualTime: "O(n)",
        actualSpace: "O(1)",
        feedback: "fb",
        suggestion: "sg",
      },
      src
    );
    expect(result.userTime).toBe("O(n^4)");
    expect(result.matches.time).toBe(false);
    expect(result.matches.space).toBe(true);
  });

  it("주석 없는 풀이는 hasUserAnnotation=false", () => {
    const result = composeSolution(
      {
        name: "solution",
        headerLine: 1,
        description: "기본",
        actualTime: "O(n)",
        actualSpace: "O(1)",
        feedback: "fb",
        suggestion: "sg",
      },
      "function solution() {}"
    );
    expect(result.userTime).toBe(null);
    expect(result.userSpace).toBe(null);
    expect(result.hasUserAnnotation).toBe(false);
    expect(result.matches).toEqual({ time: false, space: false });
  });

  it("headerLine 누락 시 user 값 null", () => {
    const src = `// tc: O(n)
function solution() {}`;
    const result = composeSolution(
      {
        name: "solution",
        description: "기본",
        actualTime: "O(n)",
        actualSpace: "O(1)",
        feedback: "fb",
        suggestion: "sg",
      },
      src
    );
    expect(result.userTime).toBe(null);
    expect(result.hasUserAnnotation).toBe(false);
  });

  it("필드 누락은 기본값으로 대체", () => {
    const result = composeSolution({}, "function f(){}");
    expect(result.name).toBe("unknown");
    expect(result.actualTime).toBe("?");
    expect(result.actualSpace).toBe("?");
    expect(result.feedback).toBe("");
    expect(result.suggestion).toBe("");
  });
});

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

  function setupFetchWithOpenAI(openaiResponse, sourceContent = PLAIN_SOURCE) {
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("two-sum")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(sourceContent);
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
                        // name, headerLine, description, feedback, suggestion 누락
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

    expect(result.analyzed).toBe(0);
    expect(result.total).toBe(1);
  });
});

// ── User prompt 에 stripped content 가 전달되는지 ─

describe("analyzeComplexity — user prompt 에 복잡도 주석 제거 + 라인 번호 적용", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("복잡도 주석은 빈 줄로 치환되어 OpenAI 에 전달된다", async () => {
    const source = `// TC: O(n)
// SC: O(1)
function solution() { return 0; }`;

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
        return makeOpenAIResponse([
          makeSingleSolutionAnalysis("two-sum", { headerLine: 3 }),
        ]);
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

    // L1 / L2 가 빈 라인으로 prefix 만 있어야 함, L3 은 함수 헤더
    expect(capturedUserContent).toContain("L1: \nL2: \nL3: function solution()");
    // 복잡도 주석 텍스트는 LLM 에 노출되면 안 됨
    expect(capturedUserContent).not.toContain("TC: O(n)");
    expect(capturedUserContent).not.toContain("SC: O(1)");
  });

  it("일반 주석은 그대로 전달된다", async () => {
    const source = `// 일반 설명 주석
function solution() { return 0; }`;

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
        return makeOpenAIResponse([
          makeSingleSolutionAnalysis("two-sum", { headerLine: 2 }),
        ]);
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

    expect(capturedUserContent).toContain("L1: // 일반 설명 주석");
    expect(capturedUserContent).toContain("L2: function solution()");
  });
});

// ── 댓글 포맷 ─────────────────────────────────────

describe("analyzeComplexity — 댓글 포맷", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupFetchAndCapture(openaiFiles, sourceContent = PLAIN_SOURCE) {
    let capturedBody = null;

    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        const files = openaiFiles.map((f) => makeSolutionFile(f.problemName));
        return okJson(files);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(sourceContent);
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
    const getBody = setupFetchAndCapture(
      [
        makeSingleSolutionAnalysis("two-sum", {
          headerLine: 3,
          actualTime: "O(n)",
          actualSpace: "O(1)",
        }),
      ],
      ANNOTATED_SOURCE
    );

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
    const getBody = setupFetchAndCapture(
      [makeSingleSolutionAnalysis("two-sum")],
      PLAIN_SOURCE
    );

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
    const mismatchSource = `// tc: O(1)
// sc: O(1)
function solution() {}`;

    const getBody = setupFetchAndCapture(
      [
        makeSingleSolutionAnalysis("two-sum", {
          headerLine: 3,
          actualTime: "O(n)",
          actualSpace: "O(1)",
        }),
      ],
      mismatchSource
    );

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
    const multiSource = `// tc: O(n^2)
// sc: O(1)
function bruteForce() {}

// tc: O(n)
// sc: O(n)
function hashMap() {}`;

    const getBody = setupFetchAndCapture(
      [
        {
          problemName: "two-sum",
          solutions: [
            {
              name: "twoSum_bruteForce",
              headerLine: 3,
              description: "brute force",
              actualTime: "O(n^2)",
              actualSpace: "O(1)",
              feedback: "정확합니다!",
              suggestion: "HashMap 으로 O(n) 가능",
            },
            {
              name: "twoSum",
              headerLine: 7,
              description: "HashMap",
              actualTime: "O(n)",
              actualSpace: "O(n)",
              feedback: "최적 풀이!",
              suggestion: "현재 구현이 적절해 보입니다.",
            },
          ],
        },
      ],
      multiSource
    );

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
        return okText(PLAIN_SOURCE);
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

  it("멀티 풀이에서 주석 있는 풀이와 없는 풀이가 섞여 있을 때 각자 올바르게 추출된다", async () => {
    // 풀이 1: 주석 있음 (헤더 위), 풀이 2: 주석 있음, 풀이 3: 주석 없음
    const mixedSource = `// tc: O(n^4)
// sc: O(n)
const findMin_a = (nums) => Math.min(...nums);

// tc: O(n^3)
// sc: O(1)
const findMin_b = (nums) => nums[0];

const findMin = (nums) => nums[0];`;

    let capturedBody = null;
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : url.url;
      const method = opts?.method ?? "GET";

      if (urlStr.includes("/pulls/") && urlStr.includes("/files")) {
        return okJson([makeSolutionFile("find-min")]);
      }
      if (urlStr.startsWith("https://raw.example.com/")) {
        return okText(mixedSource);
      }
      if (urlStr.includes("openai.com")) {
        return makeOpenAIResponse([
          {
            problemName: "find-min",
            solutions: [
              {
                name: "findMin_a",
                headerLine: 3,
                description: "Math.min 사용",
                actualTime: "O(n)",
                actualSpace: "O(n)",
                feedback: "fb1",
                suggestion: "sg1",
              },
              {
                name: "findMin_b",
                headerLine: 7,
                description: "순차 탐색",
                actualTime: "O(n)",
                actualSpace: "O(1)",
                feedback: "fb2",
                suggestion: "sg2",
              },
              {
                name: "findMin",
                headerLine: 9,
                description: "이진 탐색",
                actualTime: "O(log n)",
                actualSpace: "O(1)",
                feedback: "fb3",
                suggestion: "sg3",
              },
            ],
          },
        ]);
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

    await analyzeComplexity(
      REPO_OWNER, REPO_NAME, PR_NUMBER,
      makePrData(),
      APP_TOKEN, OPENAI_KEY
    );

    expect(capturedBody).toContain("3가지 풀이");
    expect(capturedBody).toContain("findMin_a");
    expect(capturedBody).toContain("findMin_b");
    expect(capturedBody).toContain("findMin");
    // 풀이 1: tc=O(n^4) vs actual=O(n) → 불일치 (❌)
    expect(capturedBody).toContain("O(n^4)");
    // 풀이 3: 주석 없음 → "복잡도" 단일 테이블
    expect(capturedBody).toContain("| | 복잡도 |");
    // 주석 없는 풀이가 있으니 권장 안내
    expect(capturedBody).toContain("💡 풀이에 시간/공간 복잡도를 주석으로 남겨보세요!");
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
        return okText(PLAIN_SOURCE);
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
    const bigContent = "x".repeat(20000);
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

    expect(result.total).toBe(4);
  });

  it("개별 파일이 MAX_FILE_SIZE 를 초과하면 잘라서 사용한다", async () => {
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
        const body = JSON.parse(opts.body);
        const userContent = body.messages[1].content;
        expect(userContent.length).toBeLessThanOrEqual(16000 + 200);
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
        return okText(PLAIN_SOURCE);
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
