import { describe, it, expect } from "vitest";

import { getCheckSkipReason, parsePrActionPayload } from "./prActions.js";

describe("getCheckSkipReason", () => {
  it("모든 체크가 통과하면 승인을 막지 않는다", () => {
    expect(getCheckSkipReason({ checkState: "SUCCESS" })).toBeNull();
  });

  it("체크가 실패하거나 아직 끝나지 않았으면 사유를 돌려준다", () => {
    expect(getCheckSkipReason({ checkState: "FAILURE" })).toBe("checks failure");
    expect(getCheckSkipReason({ checkState: "PENDING" })).toBe("checks pending");
    expect(getCheckSkipReason({ checkState: "ERROR" })).toBe("checks error");
  });

  it("체크가 하나도 없으면 승인하지 않는다", () => {
    expect(getCheckSkipReason({ checkState: null })).toBe("checks missing");
    expect(getCheckSkipReason({})).toBe("checks missing");
  });
});

describe("parsePrActionPayload", () => {
  it.each([
    [undefined, 400],
    ["fork-owner", 403],
    ["DaleStudy", null],
  ])("repo_owner=%s", async (owner, expectedError) => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ repo_owner: owner, repo_name: "leetcode-study", week: "Week 2" }),
    });
    const result = await parsePrActionPayload(request);
    if (expectedError) {
      expect(result.valid).toBe(false);
      expect(result.response.status).toBe(expectedError);
    } else {
      expect(result.valid).toBe(true);
      expect(result.data.repoOwner).toBe(owner);
    }
  });
});
