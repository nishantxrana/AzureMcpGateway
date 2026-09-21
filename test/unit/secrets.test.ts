import { describe, expect, it, vi } from "vitest";
import { EnvSecretProvider, secretEnvKey } from "../../src/secrets/env.js";
import {
  KeyVaultSecretProvider,
  type KeyVaultClientLike,
} from "../../src/secrets/keyvault.js";

describe("EnvSecretProvider", () => {
  it("maps secret names to SECRET__UPPER_SNAKE", () => {
    expect(secretEnvKey("ado-coolops-pat")).toBe("SECRET__ADO_COOLOPS_PAT");
  });

  it("reads secrets from env", async () => {
    const p = new EnvSecretProvider({
      NODE_ENV: "test",
      SECRET__ADO_COOLOPS_PAT: "pat-value",
    });
    await expect(p.getSecret("ado-coolops-pat")).resolves.toBe("pat-value");
  });

  it("refuses production", () => {
    expect(
      () => new EnvSecretProvider({ NODE_ENV: "production" }),
    ).toThrow(/production/);
  });

  it("throws on missing secret", async () => {
    const p = new EnvSecretProvider({ NODE_ENV: "test" });
    await expect(p.getSecret("missing")).rejects.toThrow(/Secret not found/);
  });
});

describe("KeyVaultSecretProvider cache", () => {
  it("caches positive lookups for 5 minutes", async () => {
    let now = 1_000_000;
    let calls = 0;
    const client: KeyVaultClientLike = {
      async getSecret(name) {
        calls += 1;
        return { value: `val-${name}` };
      },
    };
    const p = new KeyVaultSecretProvider({
      vaultUrl: "https://example.vault.azure.net/",
      client,
      clock: { now: () => now },
    });

    await expect(p.getSecret("s1")).resolves.toBe("val-s1");
    await expect(p.getSecret("s1")).resolves.toBe("val-s1");
    expect(calls).toBe(1);

    now += 5 * 60 * 1000 + 1;
    await expect(p.getSecret("s1")).resolves.toBe("val-s1");
    expect(calls).toBe(2);
  });

  it("negative-caches misses for 30 seconds", async () => {
    let now = 1_000_000;
    let calls = 0;
    const client: KeyVaultClientLike = {
      async getSecret() {
        calls += 1;
        throw new Error("SecretNotFound");
      },
    };
    const p = new KeyVaultSecretProvider({
      vaultUrl: "https://example.vault.azure.net/",
      client,
      clock: { now: () => now },
    });

    await expect(p.getSecret("gone")).rejects.toThrow(/Secret not found|Failed/);
    await expect(p.getSecret("gone")).rejects.toThrow(/Secret not found/);
    expect(calls).toBe(1);

    now += 30_000 + 1;
    await expect(p.getSecret("gone")).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("never logs secret values", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const spyErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client: KeyVaultClientLike = {
      async getSecret() {
        return { value: "SUPER_SECRET_SENTINEL_VALUE" };
      },
    };
    const p = new KeyVaultSecretProvider({
      vaultUrl: "https://example.vault.azure.net/",
      client,
    });
    await p.getSecret("x");
    const combined = [...spy.mock.calls, ...spyErr.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(combined).not.toContain("SUPER_SECRET_SENTINEL_VALUE");
    spy.mockRestore();
    spyErr.mockRestore();
  });
});
