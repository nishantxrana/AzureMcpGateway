import { describe, expect, it } from "vitest";
import { buildCredentials } from "../../src/ado/credentials.js";
import type { OrgEntry } from "../../src/config/registry.js";
import type { SecretProvider } from "../../src/secrets/provider.js";

const secrets: SecretProvider = {
  async getSecret(name) {
    return `value-for-${name}`;
  },
};

describe("credentials", () => {
  it("builds pat env and args", async () => {
    const org: OrgEntry = {
      alias: "coolops",
      adoOrg: "coolops",
      domains: ["core"],
      auth: { type: "pat", secret: "ado-coolops-pat" },
      clientKeys: ["mcp-coolops-key-a"],
      toolPolicy: { extraAllow: [], extraDeny: [] },
      limits: { ratePerMinute: 120, maxResponseChars: 60000 },
    };
    const c = await buildCredentials(org, secrets);
    expect(c.authArgs).toEqual([
      "--authentication",
      "pat",
      "--tenant",
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(c.env.PERSONAL_ACCESS_TOKEN).toBe(
      Buffer.from("mcp:value-for-ado-coolops-pat", "utf8").toString("base64"),
    );
    expect(Object.keys(c.env)).toEqual(["PERSONAL_ACCESS_TOKEN"]);
  });

  it("builds entra-sp env and args", async () => {
    const org: OrgEntry = {
      alias: "acme",
      adoOrg: "acme",
      domains: ["core"],
      auth: {
        type: "entra-sp",
        tenantId: "00000000-0000-0000-0000-000000000001",
        clientId: "00000000-0000-0000-0000-000000000002",
        secret: "ado-acme-sp-secret",
      },
      clientKeys: ["mcp-acme-key-a"],
      toolPolicy: { extraAllow: [], extraDeny: [] },
      limits: { ratePerMinute: 120, maxResponseChars: 60000 },
    };
    const c = await buildCredentials(org, secrets);
    expect(c.authArgs).toEqual([
      "--authentication",
      "env",
      "--tenant",
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(c.env).toEqual({
      AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000001",
      AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000002",
      AZURE_CLIENT_SECRET: "value-for-ado-acme-sp-secret",
    });
  });
});
