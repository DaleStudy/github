import { describe, it, expect, vi, beforeEach } from "bun:test";

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

describe("check-weeks repo filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it("returns 403 for non-DaleStudy organization", async () => {
    const request = makeRequest({
      repo_owner: "OtherOrg",
      repo_name: "leetcode-study",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toContain("Unauthorized organization");
  });

  it("returns 403 for non-leetcode-study repo_name", async () => {
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

  it("processes leetcode-study repo_name successfully", async () => {
    const request = makeRequest({
      repo_owner: "DaleStudy",
      repo_name: "leetcode-study",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("returns 400 when repo_name is missing", async () => {
    const request = makeRequest({
      repo_owner: "DaleStudy",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain("repo_name");
  });

  it("defaults repo_owner to DaleStudy when omitted", async () => {
    const request = makeRequest({
      repo_name: "leetcode-study",
    });

    const response = await checkWeeks(request, env);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
  });
});
