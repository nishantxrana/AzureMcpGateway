import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRegistry,
  registrySchema,
  writeOrgJsonSchema,
} from "../../src/config/registry.js";

const validOrg = {
  alias: "coolops",
  displayName: "Cool Ops",
  adoOrg: "coolops",
  domains: ["core", "repositories"],
  auth: { type: "pat" as const, secret: "ado-coolops-pat" },
  clientKeys: ["mcp-coolops-key-a"],
  toolPolicy: { extraAllow: [], extraDeny: [] },
  limits: { ratePerMinute: 120, maxResponseChars: 60000 },
};

describe("registry", () => {
  it("accepts a valid registry", () => {
    const parsed = registrySchema.parse({ version: 1, orgs: [validOrg] });
    expect(parsed.orgs[0]?.alias).toBe("coolops");
  });

  it("rejects bad alias", () => {
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [{ ...validOrg, alias: "Bad_Alias" }],
      }),
    ).toThrow(/alias/);
  });

  it("rejects bad adoOrg", () => {
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [{ ...validOrg, adoOrg: "" }],
      }),
    ).toThrow();
  });

  it("rejects empty domains", () => {
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [{ ...validOrg, domains: [] }],
      }),
    ).toThrow(/domains/);
  });

  it("rejects unknown domain", () => {
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [{ ...validOrg, domains: ["not-a-domain"] }],
      }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [{ ...validOrg, extraField: true }],
      }),
    ).toThrow();
  });

  it("rejects duplicate aliases", () => {
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [validOrg, { ...validOrg, adoOrg: "other" }],
      }),
    ).toThrow(/duplicate alias/);
  });

  it("rejects 0 or 3 clientKeys", () => {
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [{ ...validOrg, clientKeys: [] }],
      }),
    ).toThrow();
    expect(() =>
      registrySchema.parse({
        version: 1,
        orgs: [
          {
            ...validOrg,
            clientKeys: ["a", "b", "c"],
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts entra-sp auth", () => {
    const parsed = registrySchema.parse({
      version: 1,
      orgs: [
        {
          ...validOrg,
          alias: "acme",
          adoOrg: "acme-devops",
          auth: {
            type: "entra-sp",
            tenantId: "00000000-0000-0000-0000-000000000000",
            clientId: "00000000-0000-0000-0000-000000000000",
            secret: "ado-acme-sp-secret",
          },
          clientKeys: ["mcp-acme-key-a"],
        },
      ],
    });
    expect(parsed.orgs[0]?.auth.type).toBe("entra-sp");
  });

  it("loadRegistry reads a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const path = join(dir, "orgs.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, orgs: [validOrg] }),
      "utf8",
    );
    try {
      const reg = loadRegistry(path);
      expect(reg.orgs).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeOrgJsonSchema emits JSON Schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-"));
    const out = join(dir, "orgs.schema.json");
    try {
      writeOrgJsonSchema(out);
      const schema = JSON.parse(readFileSync(out, "utf8")) as {
        $schema?: string;
        definitions?: unknown;
        properties?: unknown;
      };
      expect(schema.properties ?? schema.definitions).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
