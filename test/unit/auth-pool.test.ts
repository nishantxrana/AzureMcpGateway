import { describe, expect, it } from "vitest";
import { createChildPool } from "../../src/ado/child.js";
import { ApiKeyAuthenticator, UNAUTHORIZED_BODY } from "../../src/auth/clientAuth.js";
import type { Registry } from "../../src/config/registry.js";
import type { SecretProvider } from "../../src/secrets/provider.js";
import { clientSafeError } from "../../src/mcp/gateway.js";

function registry(clientKeys: string[]): Registry {
  return {
    version: 1,
    orgs: [
      {
        alias: "coolops",
        adoOrg: "coolops",
        domains: ["core"],
        auth: { type: "pat", secret: "ado-coolops-pat" },
        clientKeys,
        toolPolicy: { extraAllow: [], extraDeny: [] },
        limits: { ratePerMinute: 120, maxResponseChars: 60000 },
      },
    ],
  };
}

function mapSecrets(values: Record<string, string>): SecretProvider {
  return {
    async getSecret(name) {
      const v = values[name];
      if (v === undefined || v === "") throw new Error(`Secret not found: ${name}`);
      return v;
    },
  };
}

describe("auth digests", () => {
  it("accepts either of two keys and rejects wrong", async () => {
    const secrets = mapSecrets({ "mcp-coolops-key-a": "aaa", "mcp-coolops-key-b": "bbb" });
    const auth = await ApiKeyAuthenticator.create(
      registry(["mcp-coolops-key-a", "mcp-coolops-key-b"]),
      secrets,
    );
    expect((await auth.authenticate("coolops", "aaa")).ok).toBe(true);
    expect((await auth.authenticate("coolops", "bbb")).ok).toBe(true);
    expect((await auth.authenticate("coolops", "ccc")).ok).toBe(false);
    expect((await auth.authenticate("missing", "aaa")).ok).toBe(false);
    expect(UNAUTHORIZED_BODY.error.message).toBe("Unauthorized");
  });

  it("a spare key that does not exist yet does not break the alias", async () => {
    const secrets = mapSecrets({ "mcp-coolops-key-a": "aaa" }); // key-b never created
    const auth = await ApiKeyAuthenticator.create(
      registry(["mcp-coolops-key-a", "mcp-coolops-key-b"]),
      secrets,
    );
    expect(await auth.checkHealth("coolops")).toBe(true);
    expect(auth.isUnhealthy("coolops")).toBe(false);
    expect((await auth.authenticate("coolops", "aaa")).ok).toBe(true);
  });

  it("alias is unhealthy only when no client key can be loaded", async () => {
    const auth = await ApiKeyAuthenticator.create(registry(["mcp-coolops-key-a"]), mapSecrets({}));
    expect(auth.isUnhealthy("coolops")).toBe(true);
    expect(await auth.checkHealth("coolops")).toBe(false);
    expect((await auth.authenticate("coolops", "anything")).ok).toBe(false);
  });

  it("picks up a rotated key without a restart", async () => {
    const values: Record<string, string> = { "mcp-coolops-key-a": "old" };
    const auth = await ApiKeyAuthenticator.create(
      registry(["mcp-coolops-key-a", "mcp-coolops-key-b"]),
      mapSecrets(values),
    );
    expect((await auth.authenticate("coolops", "old")).ok).toBe(true);

    values["mcp-coolops-key-b"] = "new"; // operator adds the spare
    expect((await auth.authenticate("coolops", "new")).ok).toBe(true);
    expect((await auth.authenticate("coolops", "old")).ok).toBe(true);

    delete values["mcp-coolops-key-a"]; // operator retires A
    expect((await auth.authenticate("coolops", "old")).ok).toBe(false);
    expect((await auth.authenticate("coolops", "new")).ok).toBe(true);
  });
});

describe("child pool", () => {
  it("queues then rejects after timeout", async () => {
    const pool = createChildPool(1, 100);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = pool.run(async () => {
      await gate;
      return 1;
    });

    await new Promise((r) => setTimeout(r, 10));
    await expect(pool.run(async () => 2)).rejects.toThrow(/Gateway busy/);

    release();
    await expect(first).resolves.toBe(1);
  });
});

describe("clientSafeError", () => {
  it("passes our own messages and hides everything else", () => {
    expect(clientSafeError("Gateway busy: too many concurrent tool calls", "r1")).toMatch(
      /Gateway busy/,
    );
    expect(clientSafeError("Child timed out after 60000ms", "r1")).toMatch(/timed out/);
    const hidden = clientSafeError("spawn /home/site/wwwroot/node_modules/x ENOENT", "r1");
    expect(hidden).not.toContain("/home/site");
    expect(hidden).toContain("r1");
  });
});
