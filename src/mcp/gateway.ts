import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import type { OrgEntry } from "../config/registry.js";
import type { Logger } from "../observability/logger.js";
import type { SecretProvider } from "../secrets/provider.js";
import {
  createChildPool,
  withAdoChild,
  type ChildPool,
} from "../ado/child.js";
import { evaluateToolCall, filterToolsByPolicy } from "../ado/toolPolicy.js";
import { shapeToolResult } from "../ado/shape.js";

const TOOL_CACHE_TTL_MS = 15 * 60 * 1000;

/** Errors whose text is written by us and safe (and useful) to show to the agent. */
const SAFE_ERROR_PREFIXES = [
  "Gateway busy",
  "Child timed out",
  "Secret not found",
  "Failed to fetch secret",
];

/**
 * Anything else (spawn errors with file paths, upstream text, stack fragments) is
 * replaced by a generic message. The full text is in the server log under requestId.
 */
export function clientSafeError(msg: string, requestId: string): string {
  if (SAFE_ERROR_PREFIXES.some((p) => msg.startsWith(p))) return msg.slice(0, 300);
  return `Upstream call failed (requestId=${requestId}). See gateway logs.`;
}

interface CacheEntry {
  tools: Tool[];
  expiresAt: number;
}

export interface GatewayDeps {
  secrets: SecretProvider;
  logger: Logger;
  adoMcpBin?: string;
  childTimeoutMs: number;
  maxConcurrentChildren: number;
  queueTimeoutMs?: number;
  childPool?: ChildPool;
  clock?: () => number;
}

export class McpGateway {
  private readonly secrets: SecretProvider;
  private readonly logger: Logger;
  private readonly adoMcpBin?: string;
  private readonly childTimeoutMs: number;
  private readonly pool: ChildPool;
  private readonly clock: () => number;
  private readonly toolCache = new Map<string, CacheEntry>();

  constructor(deps: GatewayDeps) {
    this.secrets = deps.secrets;
    this.logger = deps.logger;
    this.adoMcpBin = deps.adoMcpBin;
    this.childTimeoutMs = deps.childTimeoutMs;
    this.pool =
      deps.childPool ??
      createChildPool(deps.maxConcurrentChildren, deps.queueTimeoutMs);
    this.clock = deps.clock ?? (() => Date.now());
  }

  get childPool(): ChildPool {
    return this.pool;
  }

  invalidateToolCache(alias?: string): void {
    if (alias) this.toolCache.delete(alias);
    else this.toolCache.clear();
  }

  async warmTools(org: OrgEntry): Promise<void> {
    try {
      await this.listToolsFiltered(org);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { alias: org.alias, err: msg },
        "tools/list warm failed",
      );
    }
  }

  private async listToolsFiltered(org: OrgEntry): Promise<Tool[]> {
    const now = this.clock();
    const cached = this.toolCache.get(org.alias);
    if (cached && cached.expiresAt > now) {
      return cached.tools;
    }

    const tools = await this.pool.run(() =>
      withAdoChild(
        {
          org,
          secrets: this.secrets,
          adoMcpBin: this.adoMcpBin,
          childTimeoutMs: this.childTimeoutMs,
          logger: this.logger,
        },
        async (client) => {
          const listed = await client.listTools();
          return filterToolsByPolicy(
            listed.tools as Tool[],
            org.toolPolicy,
          );
        },
      ),
    );

    this.toolCache.set(org.alias, {
      tools,
      expiresAt: now + TOOL_CACHE_TTL_MS,
    });
    return tools;
  }

  buildServer(org: OrgEntry, requestId: string): Server {
    const server = new Server(
      { name: `ado-gateway/${org.alias}`, version: "0.1.0" },
      {
        capabilities: { tools: {} },
        ...(org.instructions
          ? { instructions: org.instructions }
          : {}),
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const started = this.clock();
      let tools: Tool[];
      try {
        tools = await this.listToolsFiltered(org);
      } catch (err) {
        this.logger.warn(
          {
            requestId,
            alias: org.alias,
            method: "tools/list",
            err: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          },
          "mcp",
        );
        throw new Error(`Tool listing failed (requestId=${requestId})`);
      }
      this.logger.info(
        {
          requestId,
          alias: org.alias,
          method: "tools/list",
          durationMs: this.clock() - started,
          outcome: "ok",
          responseChars: 0,
        },
        "mcp",
      );
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const started = this.clock();
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const actionArg = typeof args.action === "string" ? args.action : undefined;
      const argKeys = Object.keys(args);
      const project =
        typeof args.project === "string"
          ? args.project
          : typeof args.projectId === "string"
            ? args.projectId
            : undefined;

      const baseLog = {
        requestId,
        alias: org.alias,
        method: "tools/call" as const,
        tool: name,
        actionArg,
        argKeys,
        project,
      };

      const decision = evaluateToolCall(name, args, org.toolPolicy);
      if (!decision.ok) {
        this.logger.info(
          {
            ...baseLog,
            durationMs: this.clock() - started,
            outcome:
              decision.code === "tool_not_permitted"
                ? "denied"
                : "action_denied",
          },
          "mcp",
        );
        return {
          isError: true,
          content: [{ type: "text", text: decision.message }],
        };
      }

      try {
        const raw = await this.pool.run(() =>
          withAdoChild(
            {
              org,
              secrets: this.secrets,
              adoMcpBin: this.adoMcpBin,
              childTimeoutMs: this.childTimeoutMs,
              logger: this.logger,
              abortSignal: extra.signal,
            },
            (client) =>
              client.callTool({ name, arguments: args }) as Promise<{
                content?: Array<{
                  type: string;
                  text?: string;
                  [k: string]: unknown;
                }>;
                isError?: boolean;
                [k: string]: unknown;
              }>,
          ),
        );

        const rawChars = (raw.content ?? []).reduce(
          (n, b) => n + (typeof b.text === "string" ? b.text.length : 0),
          0,
        );
        const shaped = shapeToolResult(
          raw,
          org.limits.maxResponseChars,
        );
        const responseChars = shaped.content.reduce(
          (n, b) => n + (typeof b.text === "string" ? b.text.length : 0),
          0,
        );

        this.logger.info(
          {
            ...baseLog,
            durationMs: this.clock() - started,
            outcome: shaped.isError ? "tool_error" : "ok",
            rawChars,
            responseChars,
            truncated: shaped.truncated,
          },
          "mcp",
        );

        return {
          content: shaped.content,
          ...(shaped.isError !== undefined
            ? { isError: shaped.isError }
            : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "tool call failed";
        const busy = msg.includes("Gateway busy");
        this.logger.info(
          {
            ...baseLog,
            durationMs: this.clock() - started,
            outcome: busy ? "busy" : "error",
            err: msg.slice(0, 300),
          },
          "mcp",
        );
        return {
          isError: true,
          content: [{ type: "text", text: clientSafeError(msg, requestId) }],
        };
      }
    });

    return server;
  }

  async handleMcpRequest(
    org: OrgEntry,
    req: Request,
    res: Response,
    requestId: string,
  ): Promise<void> {
    const server = this.buildServer(org, requestId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const closeBoth = (): void => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    res.on("close", closeBoth);

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
