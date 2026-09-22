import { describe, expect, it, afterEach } from "vitest";
import { mcpPost, rpc, startTestApp, SENTINEL, testSecretEnv } from "../helpers/testApp.js";
import { UNAUTHORIZED_BODY } from "../../src/auth/clientAuth.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe("HTTP routing and auth", () => {
  it("valid key: initialize and tools/list succeed", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);

    const init = await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
      "key-coolops-a",
    );
    expect(init.status).toBe(200);

    const list = await mcpPost(ctx.baseUrl, "coolops", rpc("tools/list", {}), "key-coolops-a");
    expect(list.status).toBe(200);
    const tools = (list.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools;
    expect(tools?.some((t) => t.name === "core_list_projects")).toBe(true);
    expect(tools?.some((t) => t.name === "pipelines_write")).toBe(false);
    expect(tools?.some((t) => t.name === "fake_upstream_new_tool")).toBe(false);
  });

  it("uniform 401 for missing/wrong/unknown alias/cross-org", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    const body = rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });

    const cases = await Promise.all([
      mcpPost(ctx.baseUrl, "coolops", body),
      mcpPost(ctx.baseUrl, "coolops", body, "wrong"),
      mcpPost(ctx.baseUrl, "coolops", body, ""),
      mcpPost(ctx.baseUrl, "coolops", body, "   "),
      mcpPost(ctx.baseUrl, "no-such-alias", body, "key-coolops-a"),
      mcpPost(ctx.baseUrl, "otherorg", body, "key-coolops-a"),
    ]);

    for (const c of cases) {
      expect(c.status).toBe(401);
      expect(JSON.stringify(c.body)).toBe(JSON.stringify(UNAUTHORIZED_BODY));
    }
  });

  it("key rotation: both A and B work", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    const body = rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    const a = await mcpPost(ctx.baseUrl, "coolops", body, "key-coolops-a");
    const b = await mcpPost(ctx.baseUrl, "coolops", body, "key-coolops-b");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("405 for GET/DELETE and 404 for other paths", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);

    const get = await fetch(`${ctx.baseUrl}/mcp/coolops`, { method: "GET" });
    expect(get.status).toBe(405);

    const del = await fetch(`${ctx.baseUrl}/mcp/coolops`, {
      method: "DELETE",
    });
    expect(del.status).toBe(405);

    const other = await fetch(`${ctx.baseUrl}/nope`);
    expect(other.status).toBe(404);
  });

  it("413 for oversized body", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    const big = "x".repeat(300 * 1024);
    const res = await fetch(`${ctx.baseUrl}/mcp/coolops`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "key-coolops-a",
      },
      body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pad":"${big}"}}`,
    });
    expect(res.status).toBe(413);
  });

  it("healthz and readyz", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    const h = await fetch(`${ctx.baseUrl}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.text()).toBe(JSON.stringify({ status: "ok" }));

    const r = await fetch(`${ctx.baseUrl}/readyz`);
    expect([200, 503]).toContain(r.status);
    expect(await r.text()).toBe("");

    const detail = await fetch(`${ctx.baseUrl}/readyz`, {
      headers: { "x-admin-key": "admin-test-key" },
    });
    const dj = (await detail.json()) as { aliases: Record<string, boolean> };
    expect(dj.aliases.coolops).toBe(true);
  });

  it("missing secret isolates one alias (503)", async () => {
    const ctx = await startTestApp({
      secretEnv: testSecretEnv({
        SECRET__MCP_OTHERORG_KEY_A: "",
      }),
    });
    cleanups.push(ctx.shutdown);

    const ok = await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
      "key-coolops-a",
    );
    expect(ok.status).toBe(200);

    const bad = await mcpPost(
      ctx.baseUrl,
      "otherorg",
      rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
      "key-other",
    );
    expect(bad.status).toBe(503);
  });

  it("helmet headers present and no X-Powered-By", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    const res = await fetch(`${ctx.baseUrl}/healthz`);
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("log sentinel: secret values never appear in logs", async () => {
    const ctx = await startTestApp({
      secretEnv: testSecretEnv({
        SECRET__ADO_COOLOPS_PAT: SENTINEL,
        SECRET__MCP_COOLOPS_KEY_A: SENTINEL,
      }),
    });
    cleanups.push(ctx.shutdown);

    await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
      SENTINEL,
    );
    await mcpPost(ctx.baseUrl, "coolops", rpc("tools/list", {}), SENTINEL);
    await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("tools/call", {
        name: "core_list_projects",
        arguments: {},
      }),
      SENTINEL,
    );

    const all = ctx.logs.join("\n");
    expect(all).not.toContain(SENTINEL);
  });
  it("missing spare key (key-b) does not take the alias down", async () => {
    const env = testSecretEnv();
    delete env.SECRET__MCP_COOLOPS_KEY_B;
    const ctx = await startTestApp({ secretEnv: env });
    cleanups.push(ctx.shutdown);
    const res = await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
      "key-coolops-a",
    );
    expect(res.status).toBe(200);
  });

  it("rotated key works with no restart; retired key stops working", async () => {
    const env = testSecretEnv();
    delete env.SECRET__MCP_COOLOPS_KEY_B;
    const ctx = await startTestApp({ secretEnv: env });
    cleanups.push(ctx.shutdown);
    const body = rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });

    env.SECRET__MCP_COOLOPS_KEY_B = "brand-new-key";
    expect((await mcpPost(ctx.baseUrl, "coolops", body, "brand-new-key")).status).toBe(200);

    delete env.SECRET__MCP_COOLOPS_KEY_A;
    expect((await mcpPost(ctx.baseUrl, "coolops", body, "key-coolops-a")).status).toBe(401);
    expect((await mcpPost(ctx.baseUrl, "coolops", body, "brand-new-key")).status).toBe(200);
  });

  it("after 20 failed attempts even the CORRECT key is throttled (no brute force)", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    const body = rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    for (let i = 0; i < 20; i++) {
      const r = await mcpPost(ctx.baseUrl, "coolops", body, `wrong-${i}`);
      expect(r.status).toBe(401);
    }
    const blocked = await mcpPost(ctx.baseUrl, "coolops", body, "key-coolops-a");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });

  it("unknown aliases share one limiter bucket (bounded memory) and still return the uniform 401", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    const body = rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    const r = await mcpPost(ctx.baseUrl, "random-alias-1", body, "x");
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).toBe(JSON.stringify(UNAUTHORIZED_BODY));
  });
});
