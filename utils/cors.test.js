import { describe, it, expect } from "vitest";

import {
  CORS_HEADERS,
  corsResponse,
  errorResponse,
  preflightResponse,
} from "./cors.js";

function expectCorsHeaders(response) {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    CORS_HEADERS["Access-Control-Allow-Origin"]
  );
  expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
    CORS_HEADERS["Access-Control-Allow-Methods"]
  );
  expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
    CORS_HEADERS["Access-Control-Allow-Headers"]
  );
}

describe("corsResponse", () => {
  it("JSON body 와 CORS 헤더를 포함한 응답을 만든다", async () => {
    const response = corsResponse({ success: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expectCorsHeaders(response);
    expect(await response.json()).toEqual({ success: true });
  });

  it("status code 를 지정할 수 있다", async () => {
    const response = corsResponse({ accepted: true }, 202);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
  });
});

describe("preflightResponse", () => {
  it("body 없이 CORS preflight 응답을 만든다", async () => {
    const response = preflightResponse();

    expect(response.status).toBe(200);
    expectCorsHeaders(response);
    expect(await response.text()).toBe("");
  });
});

describe("errorResponse", () => {
  it("에러 메시지와 status code 를 JSON 응답으로 반환한다", async () => {
    const response = errorResponse("Not found", 404);

    expect(response.status).toBe(404);
    expectCorsHeaders(response);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("status code 기본값은 500 이다", async () => {
    const response = errorResponse("Unexpected");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unexpected" });
  });
});
