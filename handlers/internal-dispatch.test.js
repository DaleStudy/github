import { describe, it, expect, vi, beforeEach } from "bun:test";

vi.mock("../utils/github.js", () => ({
  generateGitHubAppToken: vi.fn().mockResolvedValue("fake-token"),
}));

vi.mock("./tag-patterns.js", () => ({
  tagPatterns: vi.fn().mockResolvedValue({ tagged: true }),
}));

vi.mock("./learning-status.js", () => ({
  postLearningStatus: vi.fn().mockResolvedValue({ posted: true }),
}));

import { handleInternalDispatch } from "./internal-dispatch.js";
import { tagPatterns } from "./tag-patterns.js";
import { postLearningStatus } from "./learning-status.js";
import { generateGitHubAppToken } from "../utils/github.js";

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

describe("handleInternalDispatch — authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when INTERNAL_SECRET is not configured in env", async () => {
    const request = makeRequest("/internal/tag-patterns", {
      secret: "anything",
      body: { repoOwner: "DaleStudy", repoName: "leetcode-study", prNumber: 1 },
    });

    const response = await handleInternalDispatch(
      request,
      {},
      "/internal/tag-patterns"
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
    expect(generateGitHubAppToken).not.toHaveBeenCalled();
    expect(tagPatterns).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Internal-Secret header is missing", async () => {
    const request = makeRequest("/internal/tag-patterns", {
      body: { repoOwner: "DaleStudy", repoName: "leetcode-study", prNumber: 1 },
    });

    const response = await handleInternalDispatch(
      request,
      { INTERNAL_SECRET: VALID_SECRET },
      "/internal/tag-patterns"
    );

    expect(response.status).toBe(401);
    expect(tagPatterns).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Internal-Secret header does not match env.INTERNAL_SECRET", async () => {
    const request = makeRequest("/internal/tag-patterns", {
      secret: "wrong-secret",
      body: { repoOwner: "DaleStudy", repoName: "leetcode-study", prNumber: 1 },
    });

    const response = await handleInternalDispatch(
      request,
      { INTERNAL_SECRET: VALID_SECRET },
      "/internal/tag-patterns"
    );

    expect(response.status).toBe(401);
    expect(tagPatterns).not.toHaveBeenCalled();
  });
});

describe("handleInternalDispatch — routing", () => {
  const env = { INTERNAL_SECRET: VALID_SECRET, OPENAI_API_KEY: "fake-openai" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes /internal/tag-patterns to tagPatterns with payload fields", async () => {
    const prData = { number: 42, head: { sha: "abc123" } };
    const request = makeRequest("/internal/tag-patterns", {
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
      "/internal/tag-patterns"
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.handler).toBe("tag-patterns");
    expect(tagPatterns).toHaveBeenCalledWith(
      "DaleStudy",
      "leetcode-study",
      42,
      "abc123",
      prData,
      "fake-token",
      "fake-openai"
    );
    expect(postLearningStatus).not.toHaveBeenCalled();
  });

  it("routes /internal/learning-status to postLearningStatus with payload fields", async () => {
    const request = makeRequest("/internal/learning-status", {
      secret: VALID_SECRET,
      body: {
        repoOwner: "DaleStudy",
        repoName: "leetcode-study",
        prNumber: 42,
        username: "testuser",
      },
    });

    const response = await handleInternalDispatch(
      request,
      env,
      "/internal/learning-status"
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.handler).toBe("learning-status");
    expect(postLearningStatus).toHaveBeenCalledWith(
      "DaleStudy",
      "leetcode-study",
      42,
      "testuser",
      "fake-token",
      "fake-openai"
    );
    expect(tagPatterns).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown /internal/* pathname", async () => {
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
    expect(tagPatterns).not.toHaveBeenCalled();
    expect(postLearningStatus).not.toHaveBeenCalled();
  });
});

describe("handleInternalDispatch — error handling", () => {
  const env = { INTERNAL_SECRET: VALID_SECRET, OPENAI_API_KEY: "fake-openai" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 500 when the handler throws", async () => {
    tagPatterns.mockRejectedValueOnce(new Error("boom"));

    const request = makeRequest("/internal/tag-patterns", {
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
      "/internal/tag-patterns"
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("boom");
  });
});
