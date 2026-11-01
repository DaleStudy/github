import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/github.js", () => ({
  generateGitHubAppToken: vi.fn().mockResolvedValue("fake-token"),
}));

vi.mock("./ai-review.js", () => ({
  aiReview: vi.fn().mockResolvedValue({ analyzed: 1 }),
}));

import { handleInternalDispatch } from "./internal-dispatch.js";
import { aiReview } from "./ai-review.js";
import { generateGitHubAppToken } from "../utils/github.js";

const FAKE_AI = { gateway: () => {} };

const VALID_SECRET = "test-secret-123";

function makeRequest(pathname, { secret, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (secret !== undefined) {
    headers["X-Internal-Secret"] = secret;
  }
  return new Request(`https://example.com${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

describe("handleInternalDispatch — 인증", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("env 에 INTERNAL_SECRET 이 없으면 401 을 반환한다", async () => {
    const request = makeRequest("/internal/ai-review", {
      secret: "anything",
      body: { repoOwner: "DaleStudy", repoName: "leetcode-study", prNumber: 1 },
    });

    const response = await handleInternalDispatch(
      request,
      {},
      "/internal/ai-review"
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
    expect(generateGitHubAppToken).not.toHaveBeenCalled();
    expect(aiReview).not.toHaveBeenCalled();
  });

  it("X-Internal-Secret 헤더가 없으면 401 을 반환한다", async () => {
    const request = makeRequest("/internal/ai-review", {
      body: { repoOwner: "DaleStudy", repoName: "leetcode-study", prNumber: 1 },
    });

    const response = await handleInternalDispatch(
      request,
      { INTERNAL_SECRET: VALID_SECRET },
      "/internal/ai-review"
    );

    expect(response.status).toBe(401);
    expect(aiReview).not.toHaveBeenCalled();
  });

  it("X-Internal-Secret 헤더가 env.INTERNAL_SECRET 과 일치하지 않으면 401 을 반환한다", async () => {
    const request = makeRequest("/internal/ai-review", {
      secret: "wrong-secret",
      body: { repoOwner: "DaleStudy", repoName: "leetcode-study", prNumber: 1 },
    });

    const response = await handleInternalDispatch(
      request,
      { INTERNAL_SECRET: VALID_SECRET },
      "/internal/ai-review"
    );

    expect(response.status).toBe(401);
    expect(aiReview).not.toHaveBeenCalled();
  });
});

describe("handleInternalDispatch — 라우팅", () => {
  const env = { INTERNAL_SECRET: VALID_SECRET, AI: FAKE_AI };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("/internal/ai-review 요청을 aiReview 로 payload 필드와 함께 라우팅한다", async () => {
    const prData = { number: 42, head: { sha: "abc123" } };
    const request = makeRequest("/internal/ai-review", {
      secret: VALID_SECRET,
      body: {
        repoOwner: "DaleStudy",
        repoName: "leetcode-study",
        prNumber: 42,
        headSha: "abc123",
        prData,
      },
    });

    const response = await handleInternalDispatch(
      request,
      env,
      "/internal/ai-review"
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.handler).toBe("ai-review");
    expect(aiReview).toHaveBeenCalledWith(
      "DaleStudy",
      "leetcode-study",
      42,
      "abc123",
      prData,
      "fake-token",
      FAKE_AI
    );
  });

  it.each([
    "/internal/tag-patterns",
    "/internal/learning-status",
    "/internal/complexity-analysis",
  ])("%s 는 ai-review 로 합쳐져 더 이상 라우팅되지 않고 404 를 반환한다", async (pathname) => {
    const request = makeRequest(pathname, {
      secret: VALID_SECRET,
      body: {
        repoOwner: "DaleStudy",
        repoName: "leetcode-study",
        prNumber: 42,
        prData: {},
      },
    });

    const response = await handleInternalDispatch(request, env, pathname);

    expect(response.status).toBe(404);
    expect(aiReview).not.toHaveBeenCalled();
  });

  it("알 수 없는 /internal/* 경로는 404 를 반환한다", async () => {
    const request = makeRequest("/internal/unknown", {
      secret: VALID_SECRET,
      body: {},
    });

    const response = await handleInternalDispatch(
      request,
      env,
      "/internal/unknown"
    );

    expect(response.status).toBe(404);
    expect(aiReview).not.toHaveBeenCalled();
  });
});

describe("handleInternalDispatch — 에러 처리", () => {
  const env = { INTERNAL_SECRET: VALID_SECRET, AI: FAKE_AI };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aiReview 핸들러가 throw 하면 500 을 반환한다", async () => {
    aiReview.mockRejectedValueOnce(new Error("boom"));

    const request = makeRequest("/internal/ai-review", {
      secret: VALID_SECRET,
      body: {
        repoOwner: "DaleStudy",
        repoName: "leetcode-study",
        prNumber: 1,
        headSha: "sha",
        prData: {},
      },
    });

    const response = await handleInternalDispatch(
      request,
      env,
      "/internal/ai-review"
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("boom");
  });

});
