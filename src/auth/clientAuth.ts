import { createHash, timingSafeEqual } from "node:crypto";
import type { OrgEntry, Registry } from "../config/registry.js";
import type { SecretProvider } from "../secrets/provider.js";

export const UNAUTHORIZED_BODY = Object.freeze({
  jsonrpc: "2.0",
  error: { code: -32001, message: "Unauthorized" },
  id: null,
});

export interface ClientAuthenticator {
  authenticate(
    alias: string,
    presentedKey: string | undefined,
  ): Promise<{ ok: true; org: OrgEntry } | { ok: false }>;
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string equality (compares SHA-256 digests, so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * Header X-API-Key auth with SHA-256 digests + timingSafeEqual.
 *
 * Key secrets are resolved on every request through the SecretProvider (which caches:
 * 5 min in Key Vault). That means:
 *  - rotating a key in Key Vault takes effect within the cache TTL, no restart;
 *  - a spare key (key-b) that has not been created yet does NOT break the alias;
 *  - an alias is unhealthy only when NONE of its client keys can be loaded.
 *
 * Unknown alias, missing key, and wrong key all produce the same 401 body.
 */
export class ApiKeyAuthenticator implements ClientAuthenticator {
  private readonly orgByAlias = new Map<string, OrgEntry>();
  private readonly dummyDigest = sha256("ado-gateway-dummy-compare-key");
  private readonly unhealthy = new Set<string>();

  private constructor(
    registry: Registry,
    private readonly secrets: SecretProvider,
  ) {
    for (const org of registry.orgs) this.orgByAlias.set(org.alias, org);
  }

  static async create(
    registry: Registry,
    secrets: SecretProvider,
  ): Promise<ApiKeyAuthenticator> {
    const auth = new ApiKeyAuthenticator(registry, secrets);
    // Prime health state so /readyz is meaningful right after startup.
    for (const org of registry.orgs) await auth.resolveDigests(org);
    return auth;
  }

  /** Digests of every client key that can currently be loaded. Never throws. */
  private async resolveDigests(org: OrgEntry): Promise<Buffer[]> {
    const digests: Buffer[] = [];
    for (const name of org.clientKeys) {
      try {
        digests.push(sha256(await this.secrets.getSecret(name)));
      } catch {
        // A missing spare key is normal outside rotation. Health is decided below.
      }
    }
    if (digests.length === 0) this.unhealthy.add(org.alias);
    else this.unhealthy.delete(org.alias);
    return digests;
  }

  /** Last known state (updated by every authenticate / checkHealth call). */
  isUnhealthy(alias: string): boolean {
    return this.unhealthy.has(alias);
  }

  listUnhealthy(): string[] {
    return [...this.unhealthy];
  }

  /** Fresh health check: true when at least one client key can be loaded. */
  async checkHealth(alias: string): Promise<boolean> {
    const org = this.orgByAlias.get(alias);
    if (!org) return false;
    return (await this.resolveDigests(org)).length > 0;
  }

  async authenticate(
    alias: string,
    presentedKey: string | undefined,
  ): Promise<{ ok: true; org: OrgEntry } | { ok: false }> {
    const org = this.orgByAlias.get(alias);
    const presented =
      presentedKey === undefined || presentedKey.trim() === ""
        ? ""
        : presentedKey;
    const presentedDigest = sha256(presented);

    const digests = org ? await this.resolveDigests(org) : [];

    // Always do at least one full-length compare and never short-circuit, so the
    // work done does not depend on which key (if any) matched.
    let matched = false;
    for (const digest of digests.length > 0 ? digests : [this.dummyDigest]) {
      if (timingSafeEqual(digest, presentedDigest)) matched = true;
    }

    if (!org || digests.length === 0 || !matched) return { ok: false };
    return { ok: true, org };
  }
}
