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
        PERSONAL_ACCESS_TOKEN: Buffer.from(`mcp:${pat}`, "utf8").toString("base64"),
      },
           // --tenant is unused by the ADO MCP binary's "pat" auth branch, but its
      // presence skips getOrgTenant()'s live HEAD request to
      // vssps.dev.azure.com, which is otherwise made on every single spawn.
      authArgs: [
        "--authentication",
        "pat",
        "--tenant",
        "00000000-0000-0000-0000-000000000000",
      ],
    };
  }

  const clientSecret = await secrets.getSecret(org.auth.secret);
  return {
    env: {
      AZURE_TENANT_ID: org.auth.tenantId,
      AZURE_CLIENT_ID: org.auth.clientId,
      AZURE_CLIENT_SECRET: clientSecret,
    },
    // Real tenant here — needed for OAuth authority scoping, and also skips
    // the same getOrgTenant() network call.
    authArgs: ["--authentication", "env", "--tenant", org.auth.tenantId],
  };
}
