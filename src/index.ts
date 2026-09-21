import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server as HttpServer } from "node:http";
import { loadEnv } from "./config/env.js";
import { loadRegistry, writeOrgJsonSchema } from "./config/registry.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./observability/logger.js";
import { EnvSecretProvider } from "./secrets/env.js";
import { KeyVaultSecretProvider } from "./secrets/keyvault.js";
import type { SecretProvider } from "./secrets/provider.js";

export async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger();

  try {
    writeOrgJsonSchema(path.resolve("config/orgs.schema.json"));
  } catch {
    // Run-From-Package is read-only; schema is shipped in the zip.
  }

  const registry = loadRegistry(path.resolve(env.ORG_REGISTRY_PATH));

  let secrets: SecretProvider;
  if (env.NODE_ENV === "production") {
    if (!env.KEY_VAULT_URI) {
      throw new Error("KEY_VAULT_URI is required when NODE_ENV=production");
    }
    secrets = new KeyVaultSecretProvider({ vaultUrl: env.KEY_VAULT_URI });
  } else {
    secrets = new EnvSecretProvider();
  }

  const { app, gateway, shutdown } = await createApp({
    env,
    registry,
    secrets,
    logger,
    adoMcpBin: env.ADO_MCP_BIN,
  });

  for (const org of registry.orgs) {
    void gateway.warmTools(org);
  }

  const server: HttpServer = createServer(app);
  let shuttingDown = false;

  const onSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void shutdown()
        .catch(() => undefined)
        .finally(() => {
          process.exit(0);
        });
    });
    setTimeout(() => {
      logger.warn("shutdown deadline reached");
      process.exit(0);
    }, 20_000).unref();
  };

  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  await new Promise<void>((resolve) => {
    server.listen(env.PORT, () => {
      logger.info({ port: env.PORT }, "ado-mcp-gateway listening");
      resolve();
    });
  });
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
