import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../index.js";

async function fetchWorker(input, init = {}) {
  const request = input instanceof Request ? input : new Request(input, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);

  await waitOnExecutionContext(ctx);

  return response;
}

describe("Worker runtime smoke test", () => {
  it("returns the CORS preflight response for OPTIONS requests", async () => {
    const response = await fetchWorker("https://example.com/check-weeks", {
      method: "OPTIONS",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(await response.text()).toBe("");
  });

  it("returns a JSON 404 for unknown POST routes", async () => {
    const response = await fetchWorker("https://example.com/unknown", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("routes /resolve-iteration and rejects a malformed date before hitting GitHub", async () => {
    const response = await fetchWorker("https://example.com/resolve-iteration", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ date: "2026/08/08" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid date format: 2026/08/08 (expected YYYY-MM-DD)",
    });
  });

  it("exposes WORKER_URL from wrangler config in env", () => {
    expect(env.WORKER_URL).toBe("https://github.dalestudy.workers.dev");
  });
});
