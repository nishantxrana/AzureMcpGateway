import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  ORG_REGISTRY_PATH: z.string().min(1).default("config/orgs.json"),
  KEY_VAULT_URI: z.string().url().optional(),
  CHILD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_CONCURRENT_CHILDREN: z.coerce.number().int().positive().default(6),
  /** How long a tool call may wait for a free child slot before a clean "busy" error. */
  QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ADO_MCP_BIN: z.string().min(1).optional(),
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().min(1).optional(),
});

export type AppEnv = z.infer<typeof envSchema>;
/** Preferred name in HTTP/app layer. */
export type EnvConfig = AppEnv;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
