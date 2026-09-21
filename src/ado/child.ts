import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OrgEntry } from "../config/registry.js";
import type { Logger } from "../observability/logger.js";
import { buildCredentials } from "./credentials.js";
import type { SecretProvider } from "../secrets/provider.js";

const require = createRequire(import.meta.url);

export function resolveAdoMcpBin(override?: string): string {
  if (override && override.length > 0) {
    return path.isAbsolute(override)
      ? override
      : path.resolve(process.cwd(), override);
  }
  return path.join(
    path.dirname(require.resolve("@azure-devops/mcp/package.json")),
    "dist",
    "index.js",
  );
}

export interface ChildPool {
  run<T>(fn: () => Promise<T>): Promise<T>;
  activeCount(): number;
  drain(): Promise<void>;
}

/**
 * Bounded concurrency for child spawns. Queue wait max 10s then throws busy.
 */
export function createChildPool(
  maxConcurrent: number,
  queueTimeoutMs = 10_000,
): ChildPool {
  let active = 0;
  const waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const grant = (): void => {
    active += 1;
  };

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      grant();
      next.resolve();
    }
  };

  return {
    activeCount: () => active,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < maxConcurrent) {
        grant();
      } else {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.resolve === resolve);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error("Gateway busy: too many concurrent tool calls"));
          }, queueTimeoutMs);
          waiters.push({ resolve, reject, timer });
        });
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    async drain(): Promise<void> {
      while (active > 0 || waiters.length > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

export interface WithChildOptions {
  org: OrgEntry;
  secrets: SecretProvider;
  adoMcpBin?: string;
  childTimeoutMs: number;
  logger: Logger;
  abortSignal?: AbortSignal;
}

/**
 * Spawn official (or fake) ADO MCP stdio child with minimal env, run fn, always reap.
 */
export async function withAdoChild<T>(
  opts: WithChildOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const creds = await buildCredentials(opts.org, opts.secrets);
  const bin = resolveAdoMcpBin(opts.adoMcpBin);
  const home = path.join(tmpdir(), "ado-mcp-gateway-home");

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    ...creds.env,
  };

  // Propagate fake-behavior knobs for the test fixture only.
  if (process.env.FAKE_ADO_BEHAVIOR) {
    env.FAKE_ADO_BEHAVIOR = process.env.FAKE_ADO_BEHAVIOR;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      bin,
      opts.org.adoOrg,
      ...creds.authArgs,
      "--domains",
      ...opts.org.domains,
    ],
    env,
    stderr: "pipe",
  });

  const client = new Client({ name: "ado-gateway", version: "0.1.0" });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    void transport.close().catch(() => undefined);
    killTimer = setTimeout(() => {
      // StdioClientTransport closes the process; force via close again.
      void transport.close().catch(() => undefined);
    }, 2_000);
  }, opts.childTimeoutMs);

  const onAbort = (): void => {
    void transport.close().catch(() => undefined);
  };
  opts.abortSignal?.addEventListener("abort", onAbort);

  try {
    await client.connect(transport);

    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").slice(0, 500);
        opts.logger.debug({ alias: opts.org.alias, stderr: text }, "child stderr");
      });
    }

    return await fn(client);
  } catch (err) {
    if (timedOut) {
      throw new Error(`Child timed out after ${opts.childTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    opts.abortSignal?.removeEventListener("abort", onAbort);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export function gatewayRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}
