import { DefaultAzureCredential } from "@azure/identity";
import {
  SecretClient,
  type KeyVaultSecret,
} from "@azure/keyvault-secrets";
import type { SecretProvider } from "./provider.js";

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

export interface Clock {
  now(): number;
}

export interface KeyVaultClientLike {
  getSecret(name: string): Promise<Pick<KeyVaultSecret, "value">>;
}

interface CacheEntry {
  value?: string;
  expiresAt: number;
  negative: boolean;
}

/**
 * Key Vault-backed secrets with 5 min positive TTL and 30 s negative cache.
 * Never logs secret values.
 */
export class KeyVaultSecretProvider implements SecretProvider {
  private readonly client: KeyVaultClientLike;
  private readonly clock: Clock;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: {
    vaultUrl: string;
    client?: KeyVaultClientLike;
    clock?: Clock;
  }) {
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.client =
      opts.client ??
      new SecretClient(opts.vaultUrl, new DefaultAzureCredential());
  }

  async getSecret(name: string): Promise<string> {
    const now = this.clock.now();
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > now) {
      if (hit.negative) {
        throw new Error(`Secret not found: ${name}`);
      }
      return hit.value as string;
    }

    try {
      const secret = await this.client.getSecret(name);
      const value = secret.value;
      if (value === undefined || value === "") {
        this.cache.set(name, {
          negative: true,
          expiresAt: now + NEGATIVE_TTL_MS,
        });
        throw new Error(`Secret not found: ${name}`);
      }
      this.cache.set(name, {
        value,
        negative: false,
        expiresAt: now + POSITIVE_TTL_MS,
      });
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Secret not found")) {
        this.cache.set(name, {
          negative: true,
          expiresAt: now + NEGATIVE_TTL_MS,
        });
      }
      if (msg.includes("Secret not found")) {
        throw err;
      }
      throw new Error(`Failed to fetch secret: ${name}`);
    }
  }

  /** Test helper: clear cache. */
  clearCache(): void {
    this.cache.clear();
  }
}
