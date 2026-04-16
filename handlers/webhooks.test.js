import { describe, it, expect, vi, beforeEach } from "bun:test";

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

vi.mock("./tag-patterns.js", () => ({
  tagPatterns: vi.fn(),
}));

vi.mock("./learning-status.js", () => ({
  postLearningStatus: vi.fn(),
}));

import { handleWebhook } from "./webhooks.js";
import { getPRInfoFromNodeId } from "../utils/github.js";
import {
  ensureWarningComment,
  removeWarningComment,
  handleWeekComment,
} from "../utils/prWeeks.js";

function makeRequest(eventType, payload) {
  return new Request("https://example.com/webhooks", {
    method: "POST",
    headers: { "X-GitHub-Event": eventType },
    body: JSON.stringify(payload),
  });
}

const env = {};

describe("webhook repo filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ state: "open", labels: [], draft: false }),
    });
  });

  describe("top-level filter (payload.repository)", () => {
    it("ignores immediately when payload.repository.name is not leetcode-study", async () => {
      const request = makeRequest("pull_request", {
        action: "opened",
        organization: { login: "DaleStudy" },
        repository: { name: "daleui", owner: { login: "DaleStudy" } },
        pull_request: { number: 1, labels: [], head: { sha: "abc" } },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: daleui");
    });

    it("passes when payload.repository.name is leetcode-study", async () => {
      const request = makeRequest("pull_request", {
        action: "synchronize",
        organization: { login: "DaleStudy" },
        repository: {
          name: "leetcode-study",
          owner: { login: "DaleStudy" },
        },
        pull_request: {
          number: 1,
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

  describe("projects_v2_item event repo filtering", () => {
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

    it("ignores when GraphQL lookup returns a non-leetcode-study repo", async () => {
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

    it("processes normally when GraphQL lookup returns leetcode-study", async () => {
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

    it("ignores non-leetcode-study repo on deleted action", async () => {
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

    it("ignores non-leetcode-study repo on created action", async () => {
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

  describe("organization filter", () => {
    it("ignores non-DaleStudy organization", async () => {
      const request = makeRequest("pull_request", {
        action: "opened",
        organization: { login: "OtherOrg" },
        repository: {
          name: "leetcode-study",
          owner: { login: "OtherOrg" },
        },
        pull_request: { number: 1, labels: [], head: { sha: "abc" } },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: not DaleStudy organization");
    });

    it("ignores when organization field is missing", async () => {
      const request = makeRequest("pull_request", {
        action: "opened",
        repository: {
          name: "leetcode-study",
          owner: { login: "DaleStudy" },
        },
        pull_request: { number: 1, labels: [], head: { sha: "abc" } },
      });

      const response = await handleWebhook(request, env);
      const body = await response.json();

      expect(body.message).toBe("Ignored: not DaleStudy organization");
    });
  });

  describe("event type filter", () => {
    it("ignores unsupported event types", async () => {
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
