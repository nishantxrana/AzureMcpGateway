import { describe, expect, it, afterEach } from "vitest";
import { mcpPost, rpc, startTestApp, testEnv, testSecretEnv } from "../helpers/testApp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe("policy and child isolation", () => {
  it("rejects write tools and mutating actions", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);

    await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
      "key-coolops-a",
    );

    const denied = await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("tools/call", { name: "pipelines_write", arguments: {} }),
      "key-coolops-a",
    );
    expect(denied.status).toBe(200);
    const deniedBody = denied.body as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(deniedBody.result?.isError).toBe(true);
    expect(deniedBody.result?.content?.[0]?.text).toMatch(/not permitted/i);

    const actionDenied = await mcpPost(
      ctx.baseUrl,
      "coolops",
      rpc("tools/call", {
        name: "repo_repository",
        arguments: { action: "create" },
      }),
      "key-coolops-a",
    );
    const ad = actionDenied.body as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(ad.result?.isError).toBe(true);
    expect(ad.result?.content?.[0]?.text).toMatch(/Action not permitted/i);
  });

  it("child env isolation via echo-env", async () => {
    const prev = process.env.FAKE_ADO_BEHAVIOR;
    process.env.FAKE_ADO_BEHAVIOR = "echo-env";
    process.env.KEY_VAULT_URI = "https://should-not-leak.vault.azure.net/";
    process.env.MCP_LEAK = "nope";

    try {
      const ctx = await startTestApp({
        env: testEnv({ CHILD_TIMEOUT_MS: 20_000 }),
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
        "key-coolops-a",
      );

      const call = await mcpPost(
        ctx.baseUrl,
        "coolops",
        rpc("tools/call", {
          name: "core_list_projects",
          arguments: {},
        }),
        "key-coolops-a",
      );
      const text = (
        call.body as {
          result?: { content?: Array<{ text?: string }> };
        }
      ).result?.content?.[0]?.text;
      expect(text).toBeTruthy();
      expect(text).not.toContain("KEY_VAULT_URI");
      expect(text).not.toContain("MCP_LEAK");
      expect(text).not.toContain("SECRET__");
      expect(text).toContain("envKeys");
      expect(text).toContain("PERSONAL_ACCESS_TOKEN");
      expect(text).toContain("PATH");
      expect(text).toContain("HOME");
    } finally {
      if (prev === undefined) delete process.env.FAKE_ADO_BEHAVIOR;
      else process.env.FAKE_ADO_BEHAVIOR = prev;
      delete process.env.KEY_VAULT_URI;
      delete process.env.MCP_LEAK;
    }
  });

  it("two orgs use distinct credentials", async () => {
    const prev = process.env.FAKE_ADO_BEHAVIOR;
    process.env.FAKE_ADO_BEHAVIOR = "echo-env";
    try {
      const ctx = await startTestApp({
        secretEnv: testSecretEnv({
          SECRET__ADO_COOLOPS_PAT: "pat-aaa",
          SECRET__ADO_OTHERORG_PAT: "pat-bbb",
        }),
      });
      cleanups.push(ctx.shutdown);

      const init = {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      };
      await mcpPost(ctx.baseUrl, "coolops", rpc("initialize", init), "key-coolops-a");
      await mcpPost(ctx.baseUrl, "otherorg", rpc("initialize", init), "key-other");

      const [a, b] = await Promise.all([
        mcpPost(
          ctx.baseUrl,
          "coolops",
          rpc("tools/call", { name: "core_list_projects", arguments: {} }),
          "key-coolops-a",
        ),
        mcpPost(
          ctx.baseUrl,
          "otherorg",
          rpc("tools/call", { name: "core_list_projects", arguments: {} }),
          "key-other",
        ),
      ]);

      const textA = (a.body as { result?: { content?: Array<{ text?: string }> } }).result
        ?.content?.[0]?.text;
      const textB = (b.body as { result?: { content?: Array<{ text?: string }> } }).result
        ?.content?.[0]?.text;
      expect(textA).toBeTruthy();
      expect(textB).toBeTruthy();
      expect(textA).not.toEqual(textB);
    } finally {
      if (prev === undefined) delete process.env.FAKE_ADO_BEHAVIOR;
      else process.env.FAKE_ADO_BEHAVIOR = prev;
    }
  });

  it("concurrency cap returns a clean busy tool error, then recovers", async () => {
    const prev = process.env.FAKE_ADO_BEHAVIOR;
    process.env.FAKE_ADO_BEHAVIOR = "slow"; // every call takes ~5 s
    try {
      const ctx = await startTestApp({
        env: testEnv({
          MAX_CONCURRENT_CHILDREN: 1,
          QUEUE_TIMEOUT_MS: 300,
          CHILD_TIMEOUT_MS: 30_000,
        }),
      });
      cleanups.push(ctx.shutdown);

      const init = {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      };
      await mcpPost(ctx.baseUrl, "coolops", rpc("initialize", init), "key-coolops-a");

      const call = rpc("tools/call", { name: "core_list_projects", arguments: {} });
      const p1 = mcpPost(ctx.baseUrl, "coolops", call, "key-coolops-a");
      await new Promise((r) => setTimeout(r, 200));
      const p2 = mcpPost(ctx.baseUrl, "coolops", call, "key-coolops-a");

      const [first, second] = await Promise.all([p1, p2]);
      type Body = { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      // The queued call gave up after 300 ms with a clean, actionable tool error...
      expect(second.status).toBe(200);
      expect((second.body as Body).result?.isError).toBe(true);
      expect((second.body as Body).result?.content?.[0]?.text).toMatch(/Gateway busy/);
      // ...and the first call was unaffected.
      expect((first.body as Body).result?.isError).not.toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FAKE_ADO_BEHAVIOR;
      else process.env.FAKE_ADO_BEHAVIOR = prev;
    }
  }, 60_000);

  for (const behavior of ["hang", "crash", "garbage"] as const) {
    it(`child ${behavior}: clean tool error, no internals leaked`, async () => {
      const prev = process.env.FAKE_ADO_BEHAVIOR;
      process.env.FAKE_ADO_BEHAVIOR = behavior;
      try {
        const ctx = await startTestApp({
          env: testEnv({ CHILD_TIMEOUT_MS: 1_500 }),
        });
        cleanups.push(ctx.shutdown);
        const res = await mcpPost(
          ctx.baseUrl,
          "coolops",
          rpc("tools/call", { name: "core_list_projects", arguments: {} }),
          "key-coolops-a",
        );
        const body = res.body as {
          result?: { isError?: boolean; content?: Array<{ text?: string }> };
        };
        expect(res.status).toBe(200);
        expect(body.result?.isError).toBe(true);
        const text = body.result?.content?.[0]?.text ?? "";
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/node_modules|fake-ado-mcp|\\Users\\|\/home\//);
        // If the child slot were leaked, ctx.shutdown() (pool.drain) would hang and fail the test.
      } finally {
        if (prev === undefined) delete process.env.FAKE_ADO_BEHAVIOR;
        else process.env.FAKE_ADO_BEHAVIOR = prev;
      }
    }, 30_000);
  }

  it("blocks wit_backlog.reorder and any unlisted action end to end", async () => {
    const ctx = await startTestApp();
    cleanups.push(ctx.shutdown);
    for (const args of [{ action: "reorder" }, { action: "brand_new_upstream_action" }, {}]) {
      const res = await mcpPost(
        ctx.baseUrl,
        "coolops",
        rpc("tools/call", { name: "wit_backlog", arguments: args }),
        "key-coolops-a",
      );
      const body = res.body as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Action not permitted/);
    }
  });
});
