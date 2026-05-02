import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/github.js", () => ({
  generateGitHubAppToken: vi.fn().mockResolvedValue("fake-token"),
  getGitHubHeaders: vi.fn().mockReturnValue({
    Authorization: "token fake-token",
  }),
}));

vi.mock("../utils/prWeeks.js", () => ({
  handleWeekComment: vi.fn().mockResolvedValue("Week 1"),
}));

import { checkWeeks } from "./check-weeks.js";
import { generateGitHubAppToken } from "../utils/github.js";

function makeRequest(body) {
  return new Request("https://example.com/check-weeks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const env = {};

describe("check-weeks 저장소 필터링", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it("DaleStudy 가 아닌 organization 은 403 을 반환한다", async () => {
    const request = makeRequest({
      repo_owner: "OtherOrg",
      repo_name: "leetcode-study",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toContain("Unauthorized organization");
  });

  it("leetcode-study 가 아닌 repo_name 은 403 을 반환한다", async () => {
    const request = makeRequest({
      repo_owner: "DaleStudy",
      repo_name: "daleui",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toContain("Unauthorized repository");

    expect(generateGitHubAppToken).not.toHaveBeenCalled();
  });

  it("leetcode-study repo_name 은 정상 처리한다", async () => {
    const request = makeRequest({
      repo_owner: "DaleStudy",
      repo_name: "leetcode-study",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("repo_name 이 없으면 400 을 반환한다", async () => {
    const request = makeRequest({
      repo_owner: "DaleStudy",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain("repo_name");
  });

  it("repo_owner 생략 시 DaleStudy 로 기본 설정된다", async () => {
    const request = makeRequest({
      repo_name: "leetcode-study",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
  });
});
