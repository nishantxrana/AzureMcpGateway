import type { SecretProvider } from "./provider.js";

/** Maps a Key Vault secret name to SECRET__<NAME_UPPER_SNAKE>. */
export function secretEnvKey(name: string): string {
  return `SECRET__${name.replace(/-/g, "_").toUpperCase()}`;
}

/**
 * Local/test secret provider. Refuses construction when NODE_ENV=production.
 */
export class EnvSecretProvider implements SecretProvider {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "EnvSecretProvider must not be used when NODE_ENV=production",
      );
    }
    this.env = env;
  }

  async getSecret(name: string): Promise<string> {
    const key = secretEnvKey(name);
    const value = this.env[key];
    if (value === undefined || value === "") {
      throw new Error(`Secret not found: ${name}`);
    }
    return value;
  }
}
