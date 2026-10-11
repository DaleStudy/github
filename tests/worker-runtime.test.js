import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../index.js";

async function fetchWorker(input, init = {}, bindings = env) {
  const request = input instanceof Request ? input : new Request(input, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings, ctx);

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

  describe("/webhooks signature", () => {
    const secret = "test-webhook-secret";
    const body = JSON.stringify({ zen: "ping", repository: { name: "other-repo" } });

    async function sign(payload) {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
      return "sha256=" + [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    function webhookRequest(signature) {
      const headers = { "Content-Type": "application/json", "X-GitHub-Event": "ping" };
      if (signature) headers["X-Hub-Signature-256"] = signature;
      return new Request("https://example.com/webhooks", { method: "POST", headers, body });
    }

    it("rejects webhooks when WEBHOOK_SECRET is not configured", async () => {
      const response = await fetchWorker(webhookRequest(await sign(body)), {}, { ...env, WEBHOOK_SECRET: undefined });

      expect(response.status).toBe(500);
    });

    it("rejects webhooks with a missing or wrong signature", async () => {
      const bindings = { ...env, WEBHOOK_SECRET: secret };

      expect((await fetchWorker(webhookRequest(), {}, bindings)).status).toBe(401);
      expect((await fetchWorker(webhookRequest("sha256=" + "0".repeat(64)), {}, bindings)).status).toBe(401);
    });

    it("accepts webhooks signed with WEBHOOK_SECRET", async () => {
      const response = await fetchWorker(webhookRequest(await sign(body)), {}, { ...env, WEBHOOK_SECRET: secret });

      expect(response.status).toBe(200);
    });
  });
});

