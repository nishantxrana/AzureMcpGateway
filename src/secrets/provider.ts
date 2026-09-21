export interface SecretProvider {
  getSecret(name: string): Promise<string>;
}

export class SecretNotFoundError extends Error {
  constructor(public readonly secretName: string) {
    super(`Secret not found: ${secretName}`);
    this.name = "SecretNotFoundError";
  }
}

/** Map Key Vault secret name to EnvSecretProvider env var: ado-coolops-pat -> SECRET__ADO_COOLOPS_PAT */
export function secretNameToEnvKey(name: string): string {
  return `SECRET__${name.replace(/-/g, "_").toUpperCase()}`;
}
