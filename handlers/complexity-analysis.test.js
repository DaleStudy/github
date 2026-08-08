import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  isComplexityCommentLine,
  stripComplexityComments,
  extractBigO,
  extractUserAnnotations,
  bigOEquals,
  cleanBigO,
  composeSolution,
  callComplexityAnalysis,
  renderComplexitySection,
} from "./complexity-analysis.js";

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
    choices: [{ message: { content: JSON.stringify({ files }) } }],
  });
}

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

// ── callComplexityAnalysis ────────────────────────

describe("callComplexityAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("정상 응답을 problemName 별로 매핑하여 반환한다", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        await makeOpenAIResponse([
          makeSingleSolutionAnalysis("two-sum"),
          makeSingleSolutionAnalysis("valid-parentheses"),
        ])
      );

    const fileEntries = [
      { problemName: "two-sum", content: PLAIN_SOURCE },
      { problemName: "valid-parentheses", content: PLAIN_SOURCE },
    ];

    const results = await callComplexityAnalysis(fileEntries, "fake-key");

    expect(results).toHaveLength(2);
    expect(results[0].problemName).toBe("two-sum");
    expect(results[1].problemName).toBe("valid-parentheses");
    expect(results[0].solutions[0].actualTime).toBe("O(n)");
  });

  it("OpenAI API 가 실패하면 throw 한다", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(await failResponse(429));

    await expect(
      callComplexityAnalysis(
        [{ problemName: "two-sum", content: PLAIN_SOURCE }],
        "fake-key"
      )
    ).rejects.toThrow("OpenAI API error");
  });

  it("빈 응답이면 throw 한다", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(await okJson({ choices: [{ message: {} }] }));

    await expect(
      callComplexityAnalysis(
        [{ problemName: "two-sum", content: PLAIN_SOURCE }],
        "fake-key"
      )
    ).rejects.toThrow("Empty response from OpenAI");
  });

  it("잘못된 JSON 이면 throw 한다", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      await okJson({
        choices: [{ message: { content: "not json {{{" } }],
      })
    );

    await expect(
      callComplexityAnalysis(
        [{ problemName: "two-sum", content: PLAIN_SOURCE }],
        "fake-key"
      )
    ).rejects.toThrow("OpenAI returned invalid JSON");
  });

  it("모델이 problemName 을 줄여 써도 인덱스로 폴백한다", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      await makeOpenAIResponse([
        // 입력이 longest-... 인데 모델이 long-... 로 잘림
        makeSingleSolutionAnalysis("long-prefix"),
      ])
    );

    const fileEntries = [
      { problemName: "longest-prefix", content: PLAIN_SOURCE },
    ];

    const results = await callComplexityAnalysis(fileEntries, "fake-key");

    expect(results).toHaveLength(1);
    expect(results[0].problemName).toBe("longest-prefix");
  });

  it("user prompt 에 복잡도 주석 제거 + 라인 번호 prefix 가 포함된다", async () => {
    let captured = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      captured = JSON.parse(opts.body).messages[1].content;
      return await makeOpenAIResponse([
        makeSingleSolutionAnalysis("two-sum", { headerLine: 3 }),
      ]);
    });

    const source = `// TC: O(n)
// SC: O(1)
function solution() { return 0; }`;
    await callComplexityAnalysis(
      [{ problemName: "two-sum", content: source }],
      "fake-key"
    );

    expect(captured).toContain("L1: \nL2: \nL3: function solution()");
    expect(captured).not.toContain("TC: O(n)");
    expect(captured).not.toContain("SC: O(1)");
  });

  it("AI Gateway 인증 헤더와 재시도 헤더를 함께 보낸다", async () => {
    let captured = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      captured = opts.headers;
      return await makeOpenAIResponse([makeSingleSolutionAnalysis("two-sum")]);
    });

    await callComplexityAnalysis(
      [{ problemName: "two-sum", content: PLAIN_SOURCE }],
      "fake-key"
    );

    expect(captured).toMatchObject({
      "cf-aig-authorization": "Bearer fake-key",
      "cf-aig-max-attempts": "3",
      "cf-aig-retry-delay": "1000",
      "cf-aig-backoff": "exponential",
    });
  });
});

// ── renderComplexitySection ───────────────────────

describe("renderComplexitySection", () => {
  it("단일 풀이 + 유저 주석 있음 → 비교 테이블", () => {
    const entry = {
      problemName: "two-sum",
      solutions: [
        {
          name: "solution",
          description: "",
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
    };

    const out = renderComplexitySection(entry);

    expect(out).toContain("### 📊 시간/공간 복잡도 분석");
    expect(out).toContain("| | 유저 분석 | 실제 분석 | 결과 |");
    expect(out).toContain("✅");
    expect(out).toContain("정확합니다!");
    expect(out).not.toContain("<details>");
    // 합본 댓글이라 푸터(봇 disclaimer) 가 들어가면 안 됨
    expect(out).not.toContain("자동으로 작성");
    expect(out).not.toContain("🤖");
  });

  it("단일 풀이 + 유저 주석 없음 → 복잡도 단일 테이블 + 권장 안내", () => {
    const entry = {
      problemName: "two-sum",
      solutions: [
        {
          name: "solution",
          description: "",
          hasUserAnnotation: false,
          userTime: null,
          userSpace: null,
          actualTime: "O(n)",
          actualSpace: "O(1)",
          matches: { time: false, space: false },
          feedback: "fb",
          suggestion: "sg",
        },
      ],
    };

    const out = renderComplexitySection(entry);

    expect(out).toContain("| | 복잡도 |");
    expect(out).not.toContain("유저 분석");
    expect(out).toContain("💡 풀이에 시간/공간 복잡도를 주석으로 남겨보세요!");
  });

  it("멀티 풀이 → details 접기 포맷", () => {
    const entry = {
      problemName: "two-sum",
      solutions: [
        {
          name: "twoSum_brute",
          description: "",
          hasUserAnnotation: true,
          userTime: "O(n^2)",
          userSpace: "O(1)",
          actualTime: "O(n^2)",
          actualSpace: "O(1)",
          matches: { time: true, space: true },
          feedback: "fb1",
          suggestion: "HashMap 으로 O(n) 가능",
        },
        {
          name: "twoSum",
          description: "",
          hasUserAnnotation: true,
          userTime: "O(n)",
          userSpace: "O(n)",
          actualTime: "O(n)",
          actualSpace: "O(n)",
          matches: { time: true, space: true },
          feedback: "fb2",
          suggestion: "sg2",
        },
      ],
    };

    const out = renderComplexitySection(entry);

    expect(out).toContain("<details>");
    expect(out).toContain("</details>");
    expect(out).toContain("2가지 풀이");
    expect(out).toContain("twoSum_brute");
    expect(out).toContain("twoSum");
  });

  it("solutions 가 비면 분석 결과 없음 메시지", () => {
    const out = renderComplexitySection({ problemName: "x", solutions: [] });
    expect(out).toContain("⚠️ 분석 결과가 없습니다.");
  });

  it("entry 가 null/undefined 여도 폭주하지 않는다", () => {
    expect(() => renderComplexitySection(null)).not.toThrow();
    expect(() => renderComplexitySection(undefined)).not.toThrow();
  });

  it("trailing 빈 줄을 정리한다 (합본 댓글에서 공백 누적 방지)", () => {
    const entry = {
      problemName: "x",
      solutions: [
        {
          name: "s",
          description: "",
          hasUserAnnotation: false,
          userTime: null,
          userSpace: null,
          actualTime: "O(n)",
          actualSpace: "O(1)",
          matches: { time: false, space: false },
          feedback: "",
          suggestion: "",
        },
      ],
    };
    const out = renderComplexitySection(entry);
    expect(out.endsWith("\n")).toBe(false);
    expect(out.endsWith("주석으로 남겨보세요!")).toBe(true);
  });
});
