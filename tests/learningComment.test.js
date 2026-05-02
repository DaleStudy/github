import { describe, it, expect, beforeEach } from "vitest";

import { upsertLearningStatusComment } from "../utils/learningComment.js";

const REPO_OWNER = "DaleStudy";
const REPO_NAME = "leetcode-study";
const PR_NUMBER = 42;
const APP_TOKEN = "fake-app-token";
const COMMENT_MARKER = "<!-- dalestudy-learning-status -->";

function ok(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  });
}

function parseBody(call) {
  return JSON.parse(call.init.body).body;
}

describe("upsertLearningStatusComment — usage history accumulation", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("posts a new comment with a single usage row when no prior comment exists", async () => {
    const calls = [];
    globalThis.fetch = (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (init.method === "POST") return ok({});
      return ok([]); // no existing comments
    };

    await upsertLearningStatusComment(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      `${COMMENT_MARKER}\n## body`,
      APP_TOKEN,
      { prompt_tokens: 100, completion_tokens: 50 }
    );

    const post = calls.find((c) => c.init.method === "POST");
    expect(post).toBeDefined();

    const body = parseBody(post);
    expect(body).toContain("🔢 API 사용량 (gpt-4.1-nano)");
    expect(body).toContain("| 1 | 100 | 50 | 150 |");
    // single-row history => no totals row
    expect(body).not.toContain("**합계**");
    // hidden marker stores an array
    expect(body).toMatch(/<!-- usage-data: \[\{"prompt":100,"completion":50\}\] -->/);

    globalThis.fetch = originalFetch;
  });

  it("accumulates usage rows across PR updates when prior usage marker is present", async () => {
    const previousBody = [
      COMMENT_MARKER,
      "## existing body",
      "",
      `<!-- usage-data: [{"prompt":100,"completion":50},{"prompt":200,"completion":80}] -->`,
    ].join("\n");

    const calls = [];
    globalThis.fetch = (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes(`/issues/${PR_NUMBER}/comments`) && (!init.method || init.method === "GET")) {
        return ok([
          {
            id: 999,
            user: { type: "Bot" },
            body: previousBody,
          },
        ]);
      }
      if (init.method === "PATCH") return ok({});
      return ok([]);
    };

    await upsertLearningStatusComment(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      `${COMMENT_MARKER}\n## new body`,
      APP_TOKEN,
      { prompt_tokens: 300, completion_tokens: 120 }
    );

    const patch = calls.find((c) => c.init.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch.url).toContain("/issues/comments/999");

    const body = parseBody(patch);
    // all three calls present, in order
    expect(body).toContain("| 1 | 100 | 50 | 150 |");
    expect(body).toContain("| 2 | 200 | 80 | 280 |");
    expect(body).toContain("| 3 | 300 | 120 | 420 |");
    // totals row appears once history.length > 1
    expect(body).toContain("| **합계** | **600** | **250** | **850** |");
    // marker is rewritten with the full array
    expect(body).toMatch(
      /<!-- usage-data: \[\{"prompt":100,"completion":50\},\{"prompt":200,"completion":80\},\{"prompt":300,"completion":120\}\] -->/
    );

    globalThis.fetch = originalFetch;
  });

  it("falls back to a single-row history when the prior marker is malformed", async () => {
    // legacy / corrupt marker (object instead of array) — should not crash, just reset
    const previousBody = [
      COMMENT_MARKER,
      "## existing body",
      "",
      `<!-- usage-data: {"prompt":100,"completion":50} -->`,
    ].join("\n");

    const calls = [];
    globalThis.fetch = (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes(`/issues/${PR_NUMBER}/comments`) && (!init.method || init.method === "GET")) {
        return ok([
          { id: 1, user: { type: "Bot" }, body: previousBody },
        ]);
      }
      if (init.method === "PATCH") return ok({});
      return ok([]);
    };

    await upsertLearningStatusComment(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      `${COMMENT_MARKER}\n## new body`,
      APP_TOKEN,
      { prompt_tokens: 999, completion_tokens: 111 }
    );

    const patch = calls.find((c) => c.init.method === "PATCH");
    const body = parseBody(patch);

    expect(body).toContain("| 1 | 999 | 111 | 1,110 |");
    expect(body).not.toContain("**합계**");

    globalThis.fetch = originalFetch;
  });

  it("omits the usage section entirely when no usage is provided", async () => {
    const calls = [];
    globalThis.fetch = (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (init.method === "POST") return ok({});
      return ok([]);
    };

    await upsertLearningStatusComment(
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      `${COMMENT_MARKER}\n## body`,
      APP_TOKEN
      // no usage
    );

    const post = calls.find((c) => c.init.method === "POST");
    const body = parseBody(post);
    expect(body).not.toContain("🔢 API 사용량");
    expect(body).not.toContain("usage-data:");

    globalThis.fetch = originalFetch;
  });
});
