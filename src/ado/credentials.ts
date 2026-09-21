import type { OrgEntry } from "../config/registry.js";
import type { SecretProvider } from "../secrets/provider.js";

export interface ChildCredentialMaterial {
  env: Record<string, string>;
  authArgs: string[];
}

export async function buildCredentials(
  org: OrgEntry,
  secrets: SecretProvider,
): Promise<ChildCredentialMaterial> {
  if (org.auth.type === "pat") {
    const pat = await secrets.getSecret(org.auth.secret);
    return {
      env: {
        PERSONAL_ACCESS_TOKEN: Buffer.from(`mcp:${pat}`, "utf8").toString(
          "base64",
        ),
      },
      authArgs: ["--authentication", "pat"],
    };
  }

  const clientSecret = await secrets.getSecret(org.auth.secret);
  return {
    env: {
      AZURE_TENANT_ID: org.auth.tenantId,
      AZURE_CLIENT_ID: org.auth.clientId,
      AZURE_CLIENT_SECRET: clientSecret,
    },
    authArgs: ["--authentication", "env"],
  };
}
