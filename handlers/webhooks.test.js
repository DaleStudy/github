import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/github.js", () => ({
  generateGitHubAppToken: vi.fn().mockResolvedValue("fake-token"),
  getPRInfoFromNodeId: vi.fn(),
  getGitHubHeaders: vi.fn().mockReturnValue({
    Authorization: "token fake-token",
  }),
}));

vi.mock("../utils/prWeeks.js", () => ({
  ensureWarningComment: vi.fn().mockResolvedValue(false),
  removeWarningComment: vi.fn().mockResolvedValue(false),
  handleWeekComment: vi.fn().mockResolvedValue("Week 1"),
}));

vi.mock("../utils/prReview.js", () => ({
  performAIReview: vi.fn(),
  addReactionToComment: vi.fn(),
}));

vi.mock("../utils/prActions.js", () => ({
  hasApprovedReview: vi.fn(),
  safeJson: vi.fn(),
}));

vi.mock("./ai-review.js", () => ({
  aiReview: vi.fn(),
}));

import { handleWebhook } from "./webhooks.js";
import { getPRInfoFromNodeId } from "../utils/github.js";
import {
  ensureWarningComment,
  removeWarningComment,
  handleWeekComment,
} from "../utils/prWeeks.js";
import { aiReview } from "./ai-review.js";

const FAKE_AI = { gateway: () => {} };

function makeRequest(eventType, payload) {
  return new Request("https://example.com/webhooks", {
    method: "POST",
    headers: { "X-GitHub-Event": eventType },
    body: JSON.stringify(payload),
  });
}

const env = {};

describe("webhook 저장소 필터링", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          state: "open",
          title: "[testuser] WEEK 01 Solutions",
          labels: [],
          draft: false,
        }),
    });
  });

  describe("최상위 필터 (payload.repository)", () => {
    it("payload.repository.name 이 leetcode-study 가 아니면 즉시 무시한다", async () => {
      const request = makeRequest("pull_request", {
        action: "opened",
        organization: { login: "DaleStudy" },
        repository: { name: "daleui", owner: { login: "DaleStudy" } },
        pull_request: {
          number: 1,
          title: "[testuser] WEEK 01 Solutions",
          labels: [],
          head: { sha: "abc" },
        },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: daleui");
    });

    it("payload.repository.name 이 leetcode-study 면 통과시킨다", async () => {
      const request = makeRequest("pull_request", {
        action: "synchronize",
        organization: { login: "DaleStudy" },
        repository: {
          name: "leetcode-study",
          owner: { login: "DaleStudy" },
        },
        pull_request: {
          number: 1,
          title: "[testuser] WEEK 01 Solutions",
          labels: [],
          head: { sha: "abc" },
          user: { login: "testuser" },
        },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Processed");
    });
  });

  describe("projects_v2_item 이벤트 저장소 필터링", () => {
    const basePayload = {
      action: "edited",
      organization: { login: "DaleStudy" },
      projects_v2_item: {
        content_type: "PullRequest",
        content_node_id: "PR_node123",
      },
      changes: {
        field_value: {
          field_name: "Week",
          to: { title: "Week 1" },
        },
      },
    };

    it("GraphQL 조회 결과가 leetcode-study 가 아니면 무시한다", async () => {
      getPRInfoFromNodeId.mockResolvedValue({
        number: 962,
        owner: "DaleStudy",
        repo: "daleui",
      });

      const request = makeRequest("projects_v2_item", basePayload);
      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: daleui");
      expect(ensureWarningComment).not.toHaveBeenCalled();
      expect(removeWarningComment).not.toHaveBeenCalled();
    });

    it("GraphQL 조회 결과가 leetcode-study 면 정상 처리한다", async () => {
      getPRInfoFromNodeId.mockResolvedValue({
        number: 100,
        owner: "DaleStudy",
        repo: "leetcode-study",
      });

      const request = makeRequest("projects_v2_item", basePayload);
      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Processed");
    });

    it("deleted 액션에서 leetcode-study 가 아닌 저장소는 무시한다", async () => {
      getPRInfoFromNodeId.mockResolvedValue({
        number: 962,
        owner: "DaleStudy",
        repo: "daleui",
      });

      const request = makeRequest("projects_v2_item", {
        ...basePayload,
        action: "deleted",
      });
      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: daleui");
      expect(ensureWarningComment).not.toHaveBeenCalled();
    });

    it("created 액션에서 leetcode-study 가 아닌 저장소는 무시한다", async () => {
      getPRInfoFromNodeId.mockResolvedValue({
        number: 962,
        owner: "DaleStudy",
        repo: "daleui",
      });

      const request = makeRequest("projects_v2_item", {
        ...basePayload,
        action: "created",
      });
      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: daleui");
      expect(handleWeekComment).not.toHaveBeenCalled();
    });
  });

  describe("organization 필터", () => {
    it("DaleStudy 가 아닌 organization 은 무시한다", async () => {
      const request = makeRequest("pull_request", {
        action: "opened",
        organization: { login: "OtherOrg" },
        repository: {
          name: "leetcode-study",
          owner: { login: "OtherOrg" },
        },
        pull_request: {
          number: 1,
          title: "[testuser] WEEK 01 Solutions",
          labels: [],
          head: { sha: "abc" },
        },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: not DaleStudy organization");
    });

    it("organization 필드가 없으면 무시한다", async () => {
      const request = makeRequest("pull_request", {
        action: "opened",
        repository: {
          name: "leetcode-study",
          owner: { login: "DaleStudy" },
        },
        pull_request: {
          number: 1,
          title: "[testuser] WEEK 01 Solutions",
          labels: [],
          head: { sha: "abc" },
        },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: not DaleStudy organization");
    });
  });

  describe("이벤트 타입 필터", () => {
    it("지원하지 않는 이벤트 타입은 무시한다", async () => {
      const request = makeRequest("push", {
        organization: { login: "DaleStudy" },
        repository: {
          name: "leetcode-study",
          owner: { login: "DaleStudy" },
        },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: push");
    });
  });
});

describe("handlePullRequestEvent — AI 핸들러 디스패치", () => {
  const basePRPayload = {
    action: "synchronize",
    organization: { login: "DaleStudy" },
    repository: {
      name: "leetcode-study",
      owner: { login: "DaleStudy" },
    },
    pull_request: {
      number: 42,
      title: "[testuser] WEEK 01 Solutions",
      labels: [],
      head: { sha: "head-sha" },
      user: { login: "testuser" },
    },
  };

  function makeCtx() {
    return { waitUntil: vi.fn() };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });

  it("AI 바인딩, INTERNAL_SECRET, WORKER_URL 이 모두 설정되면 ctx.waitUntil 로 self-fetch 1 회를 디스패치한다", async () => {
    const ctx = makeCtx();
    const env = {
      AI: FAKE_AI,
      INTERNAL_SECRET: "fake-secret",
      WORKER_URL: "https://worker.test",
    };

    const response = await handleWebhook(
      makeRequest("pull_request", basePRPayload),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

    const fetchedUrls = globalThis.fetch.mock.calls.map(([url]) => url);
    expect(fetchedUrls).toEqual(["https://worker.test/internal/ai-review"]);

    const dispatchCall = globalThis.fetch.mock.calls.find(([url]) =>
      url.endsWith("/internal/ai-review")
    );
    expect(dispatchCall[1].headers["X-Internal-Secret"]).toBe("fake-secret");

    expect(aiReview).not.toHaveBeenCalled();
  });

  it("INTERNAL_SECRET 이 없으면 in-process 핸들러 호출로 폴백한다", async () => {
    const ctx = makeCtx();
    const env = {
      AI: FAKE_AI,
      WORKER_URL: "https://worker.test",
    };

    const response = await handleWebhook(
      makeRequest("pull_request", basePRPayload),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(aiReview).toHaveBeenCalledTimes(1);

    const [repoOwner, repoName, prNumber] = aiReview.mock.calls[0];
    expect(repoOwner).toBe("DaleStudy");
    expect(repoName).toBe("leetcode-study");
    expect(prNumber).toBe(42);
  });

  it("WORKER_URL 이 없으면 in-process 핸들러 호출로 폴백한다", async () => {
    const ctx = makeCtx();
    const env = {
      AI: FAKE_AI,
      INTERNAL_SECRET: "fake-secret",
    };

    const response = await handleWebhook(
      makeRequest("pull_request", basePRPayload),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(aiReview).toHaveBeenCalledTimes(1);
  });

  it("AI 바인딩이 없으면 디스패치도 핸들러 호출도 하지 않는다", async () => {
    const ctx = makeCtx();
    const env = {
      INTERNAL_SECRET: "fake-secret",
      WORKER_URL: "https://worker.test",
    };

    const response = await handleWebhook(
      makeRequest("pull_request", basePRPayload),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(aiReview).not.toHaveBeenCalled();
  });

});

describe("handlePullRequestEvent — WEEK 가 없는 제목", () => {
  const onboardingPayload = {
    action: "opened",
    organization: { login: "DaleStudy" },
    repository: {
      name: "leetcode-study",
      owner: { login: "DaleStudy" },
    },
    pull_request: {
      number: 43,
      title: "[testuser] Onboarding",
      labels: [],
      head: { sha: "head-sha" },
      user: { login: "testuser" },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });

  it.each([
    ["[testuser] Onboarding", true],
    ["docs: update README", false],
  ])("%s: Week 검사 여부는 %s이고 AI 리뷰는 디스패치한다", async (title, checksWeek) => {
    const ctx = { waitUntil: vi.fn() };
    const env = {
      AI: FAKE_AI,
      INTERNAL_SECRET: "fake-secret",
      WORKER_URL: "https://worker.test",
    };

    const response = await handleWebhook(
      makeRequest("pull_request", {
        ...onboardingPayload,
        pull_request: { ...onboardingPayload.pull_request, title },
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(handleWeekComment).toHaveBeenCalledTimes(checksWeek ? 1 : 0);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

    const fetchedUrls = globalThis.fetch.mock.calls.map(([url]) => url);
    expect(fetchedUrls).toEqual(["https://worker.test/internal/ai-review"]);
  });
});
