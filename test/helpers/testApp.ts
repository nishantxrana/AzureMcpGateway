import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Express } from "express";
import { createApp, type AppDeps } from "../../src/http/app.js";
import { createLogger } from "../../src/observability/logger.js";
import { EnvSecretProvider } from "../../src/secrets/env.js";
import type { Registry } from "../../src/config/registry.js";
import type { EnvConfig } from "../../src/config/env.js";

export const FAKE_BIN = path.resolve("test/fixtures/fake-ado-mcp.mjs");

export const SENTINEL = "SENTINEL_SECRET_VALUE_9f3a2b";

export function testRegistry(): Registry {
  return {
    version: 1,
    orgs: [
      {
        alias: "coolops",
        displayName: "Cool Ops",
        adoOrg: "coolops",
        domains: ["core", "repositories", "pipelines", "work-items", "wiki"],
        auth: { type: "pat", secret: "ado-coolops-pat" },
        clientKeys: ["mcp-coolops-key-a", "mcp-coolops-key-b"],
        toolPolicy: { extraAllow: [], extraDeny: [] },
        limits: { ratePerMinute: 120, maxResponseChars: 60000 },
        instructions: "test instructions",
      },
      {
        alias: "otherorg",
        adoOrg: "otherorg",
        domains: ["core", "wiki"],
        auth: { type: "pat", secret: "ado-otherorg-pat" },
        clientKeys: ["mcp-otherorg-key-a"],
        toolPolicy: { extraAllow: [], extraDeny: [] },
        limits: { ratePerMinute: 120, maxResponseChars: 60000 },
      },
    ],
  };
}

export function testEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    PORT: 0,
    NODE_ENV: "test",
    ORG_REGISTRY_PATH: "config/orgs.json",
    CHILD_TIMEOUT_MS: 15_000,
    MAX_CONCURRENT_CHILDREN: 6,
    QUEUE_TIMEOUT_MS: 10_000,
    ADO_MCP_BIN: FAKE_BIN,
    ...overrides,
  };
}

export function testSecretEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    SECRET__ADO_COOLOPS_PAT: "pat-coolops",
    SECRET__MCP_COOLOPS_KEY_A: "key-coolops-a",
    SECRET__MCP_COOLOPS_KEY_B: "key-coolops-b",
    SECRET__ADO_OTHERORG_PAT: "pat-otherorg",
    SECRET__MCP_OTHERORG_KEY_A: "key-other",
    SECRET__MCP_ADMIN_KEY: "admin-test-key",
    ...extra,
  };
}

export async function startTestApp(
  overrides: Partial<AppDeps> & {
    secretEnv?: NodeJS.ProcessEnv;
    registry?: Registry;
  } = {},
): Promise<{
  baseUrl: string;
  server: Server;
  app: Express;
  shutdown: () => Promise<void>;
  logs: string[];
}> {
  const logs: string[] = [];
  const logStream = {
    write(chunk: string) {
      logs.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  const logger = createLogger({ level: "info", destination: logStream });
  const secretEnv = overrides.secretEnv ?? testSecretEnv();
  const secrets = overrides.secrets ?? new EnvSecretProvider(secretEnv);
  const registry = overrides.registry ?? testRegistry();
  const env = overrides.env ?? testEnv();

  const { app, shutdown } = await createApp({
    env,
    registry,
    secrets,
    logger,
    adoMcpBin: env.ADO_MCP_BIN ?? FAKE_BIN,
    ...overrides,
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    server,
    app,
    logs,
    shutdown: async () => {
      await shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function mcpPost(
  baseUrl: string,
  alias: string,
  body: unknown,
  apiKey?: string,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (apiKey !== undefined) headers["x-api-key"] = apiKey;

  const res = await fetch(`${baseUrl}/mcp/${alias}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // leave as text
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export function rpc(method: string, params?: unknown, id = 1): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}
