import { randomUUID } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import type { Logger } from "../observability/logger.js";
import type { EnvConfig } from "../config/env.js";
import {
  ALIAS_REGEX,
  type OrgEntry,
  type Registry,
  getOrgByAlias,
} from "../config/registry.js";
import type { SecretProvider } from "../secrets/provider.js";
import {
  ApiKeyAuthenticator,
  UNAUTHORIZED_BODY,
  safeEqual,
} from "../auth/clientAuth.js";
import { McpGateway } from "../mcp/gateway.js";

const BODY_LIMIT = 256 * 1024;
const DEFAULT_RATE_PER_MINUTE = 120;
const FAILED_AUTH_PER_MINUTE = 20;
const UNKNOWN_BUCKET = "_unknown";

export interface AppDeps {
  env: EnvConfig;
  registry: Registry;
  secrets: SecretProvider;
  logger: Logger;
  adoMcpBin?: string;
  authenticator?: ApiKeyAuthenticator;
  gateway?: McpGateway;
  adminKeyResolver?: () => Promise<string | undefined>;
  /** Injected for tests: override readiness secret checks. */
  readinessCheck?: () => Promise<{
    ok: boolean;
    aliases: Record<string, boolean>;
  }>;
}

export interface CreatedApp {
  app: Express;
  gateway: McpGateway;
  authenticator: ApiKeyAuthenticator;
  shutdown: () => Promise<void>;
}

function sendUnauthorized(res: Response): void {
  res.status(401).type("json").send(JSON.stringify(UNAUTHORIZED_BODY));
}

function jsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res
    .status(status)
    .json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export async function createApp(deps: AppDeps): Promise<CreatedApp> {
  const authenticator =
    deps.authenticator ??
    (await ApiKeyAuthenticator.create(deps.registry, deps.secrets));

  const gateway =
    deps.gateway ??
    new McpGateway({
      secrets: deps.secrets,
      logger: deps.logger,
      adoMcpBin: deps.adoMcpBin ?? deps.env.ADO_MCP_BIN,
      childTimeoutMs: deps.env.CHILD_TIMEOUT_MS,
      maxConcurrentChildren: deps.env.MAX_CONCURRENT_CHILDREN,
      queueTimeoutMs: deps.env.QUEUE_TIMEOUT_MS,
    });

  const app = express();
  // Azure App Service puts exactly one front end in front of the app.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).type("json").send(JSON.stringify({ status: "ok" }));
  });

  const resolveAdminKey =
    deps.adminKeyResolver ??
    (async () => {
      try {
        return await deps.secrets.getSecret("mcp-admin-key");
      } catch {
        return undefined;
      }
    });

  const defaultReadiness = async (): Promise<{
    ok: boolean;
    aliases: Record<string, boolean>;
  }> => {
    const aliases: Record<string, boolean> = {};
    let ok = true;
    for (const org of deps.registry.orgs) {
      const healthy = await authenticator.checkHealth(org.alias);
      aliases[org.alias] = healthy;
      if (!healthy) ok = false;
    }
    return { ok, aliases };
  };

  app.get("/readyz", async (req, res) => {
    const check = deps.readinessCheck
      ? await deps.readinessCheck()
      : await defaultReadiness();

    const adminPresented = req.get("x-admin-key");
    const adminExpected = await resolveAdminKey();
    const showDetail =
      typeof adminPresented === "string" &&
      adminExpected !== undefined &&
      safeEqual(adminPresented, adminExpected);

    if (showDetail) {
      res.status(check.ok ? 200 : 503).json({
        status: check.ok ? "ready" : "not_ready",
        aliases: check.aliases,
      });
      return;
    }

    res.status(check.ok ? 200 : 503).end();
  });

  // ---- /mcp/:alias pipeline -------------------------------------------------
  // requestId -> failed-auth limiter -> per-alias limiter -> auth -> body parse -> MCP.
  // Auth runs BEFORE the body is parsed so anonymous callers cannot make us parse 256 KB.

  /** Known aliases get their own bucket; every unknown string shares one (bounded memory). */
  const bucketFor = (req: Request): string => {
    const alias = String(req.params.alias ?? "");
    return getOrgByAlias(deps.registry, alias) ? alias : UNKNOWN_BUCKET;
  };

  // Counts only responses with status >= 400 (401, 429, 503...) and blocks BEFORE auth runs,
  // so a caller over the limit cannot keep guessing keys even if a guess would be right.
  const failedAuthLimiter = rateLimit({
    windowMs: 60_000,
    limit: FAILED_AUTH_PER_MINUTE,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${bucketFor(req)}:${req.ip ?? "unknown"}`,
    handler: (_req, res) => {
      res.setHeader("Retry-After", "60");
      jsonRpcError(res, 429, -32000, "Too many failed requests");
    },
  });

  const aliasLimiter = rateLimit({
    windowMs: 60_000,
    limit: (req) =>
      getOrgByAlias(deps.registry, String(req.params.alias ?? ""))?.limits
        .ratePerMinute ?? DEFAULT_RATE_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${bucketFor(req)}:${req.ip ?? "unknown"}`,
    handler: (_req, res) => {
      res.setHeader("Retry-After", "60");
      jsonRpcError(res, 429, -32000, "Rate limit exceeded");
    },
  });

  const assignRequestId = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  };

  const authenticate = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const requestId = res.locals.requestId as string;
    const alias = String(req.params.alias ?? "");

    if (!ALIAS_REGEX.test(alias)) {
      sendUnauthorized(res);
      return;
    }

    const orgEntry = getOrgByAlias(deps.registry, alias);
    if (orgEntry && !(await authenticator.checkHealth(alias))) {
      jsonRpcError(res, 503, -32000, "Organization temporarily unavailable");
      return;
    }

    const auth = await authenticator.authenticate(
      alias,
      req.get("x-api-key") ?? undefined,
    );
    if (!auth.ok) {
      deps.logger.info(
        {
          requestId,
          alias,
          method: "auth",
          outcome: "unauthorized",
          httpStatus: 401,
        },
        "auth",
      );
      sendUnauthorized(res);
      return;
    }

    res.locals.org = auth.org;
    next();
  };

  const jsonParser = express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  });

  const parseBody = (req: Request, res: Response, next: NextFunction): void => {
    jsonParser(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      const type =
        typeof err === "object" && "type" in err
          ? (err as { type?: string }).type
          : undefined;
      if (type === "entity.too.large") {
        jsonRpcError(res, 413, -32000, "Payload Too Large");
        return;
      }
      jsonRpcError(res, 400, -32700, "Parse error");
    });
  };

  app.post(
    "/mcp/:alias",
    assignRequestId,
    failedAuthLimiter,
    aliasLimiter,
    authenticate,
    parseBody,
    async (req, res) => {
      const requestId = res.locals.requestId as string;
      const org = res.locals.org as OrgEntry;
      try {
        await gateway.handleMcpRequest(org, req, res, requestId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "internal error";
        deps.logger.error(
          { requestId, alias: org.alias, err: msg.slice(0, 300) },
          "mcp handler failed",
        );
        if (!res.headersSent) {
          jsonRpcError(
            res,
            500,
            -32603,
            `Internal error (requestId=${requestId})`,
          );
        }
      }
    },
  );

  const methodNotAllowed = (req: Request, res: Response): void => {
    jsonRpcError(res, 405, -32000, `Method ${req.method} not allowed`);
  };

  app.get("/mcp/:alias", methodNotAllowed);
  app.delete("/mcp/:alias", methodNotAllowed);

  app.use((_req, res) => {
    jsonRpcError(res, 404, -32000, "Not Found");
  });

  // Last-resort error handler: never leak internals.
  app.use(
    (
      _err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ): void => {
      if (!res.headersSent) jsonRpcError(res, 400, -32700, "Parse error");
    },
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await gateway.childPool.drain();
  };

  return { app, gateway, authenticator, shutdown };
}
