import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";

export const KNOWN_DOMAINS = [
  "core",
  "work",
  "work-items",
  "search",
  "test-plans",
  "repositories",
  "wiki",
  "pipelines",
  "advanced-security",
] as const;

export type KnownDomain = (typeof KNOWN_DOMAINS)[number];

const aliasSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "alias must match ^[a-z0-9][a-z0-9-]{1,30}$");

const adoOrgSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/,
    "adoOrg must match ^[A-Za-z0-9][A-Za-z0-9-]{0,49}$",
  );

const secretNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9-]{1,127}$/, "secret name must match ^[a-zA-Z0-9-]{1,127}$");

const domainSchema = z.enum(KNOWN_DOMAINS);

const patAuthSchema = z
  .object({
    type: z.literal("pat"),
    secret: secretNameSchema,
  })
  .strict();

const entraSpAuthSchema = z
  .object({
    type: z.literal("entra-sp"),
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    secret: secretNameSchema,
  })
  .strict();

export const orgEntrySchema = z
  .object({
    alias: aliasSchema,
    displayName: z.string().min(1).optional(),
    adoOrg: adoOrgSchema,
    domains: z.array(domainSchema).nonempty(),
    auth: z.discriminatedUnion("type", [patAuthSchema, entraSpAuthSchema]),
    clientKeys: z.array(secretNameSchema).min(1).max(2),
    toolPolicy: z
      .object({
        extraAllow: z.array(z.string()).default([]),
        extraDeny: z.array(z.string()).default([]),
      })
      .strict()
      .default({ extraAllow: [], extraDeny: [] }),
    limits: z
      .object({
        ratePerMinute: z.number().int().positive().default(120),
        maxResponseChars: z.number().int().positive().default(60_000),
      })
      .strict()
      .default({ ratePerMinute: 120, maxResponseChars: 60_000 }),
    instructions: z.string().optional(),
  })
  .strict();

export const registrySchema = z
  .object({
    version: z.literal(1),
    orgs: z.array(orgEntrySchema).min(1),
  })
  .strict()
  .superRefine((reg, ctx) => {
    const seen = new Set<string>();
    for (const [i, org] of reg.orgs.entries()) {
      if (seen.has(org.alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate alias "${org.alias}"`,
          path: ["orgs", i, "alias"],
        });
      }
      seen.add(org.alias);
    }
  });

export type OrgEntry = z.infer<typeof orgEntrySchema>;
export type Registry = z.infer<typeof registrySchema>;

export function loadRegistry(path: string): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "read failed";
    throw new Error(`Failed to load org registry at ${path}: ${detail}`);
  }
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid org registry at ${path}: ${issues}`);
  }
  return parsed.data;
}

export function getOrgByAlias(registry: Registry, alias: string): OrgEntry | undefined {
  return registry.orgs.find((o) => o.alias === alias);
}

export const ALIAS_REGEX = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function writeRegistryJsonSchema(outPath: string): void {
  const schema = zodToJsonSchema(registrySchema, {
    name: "AdoMcpOrgRegistry",
    $refStrategy: "none",
  });
  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
}

/** Alias used by callers that prefer the shorter name. */
export const writeOrgJsonSchema = writeRegistryJsonSchema;
