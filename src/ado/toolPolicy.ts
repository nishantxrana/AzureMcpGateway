/**
 * Default-deny tool + action policy.
 *
 * Source of truth: config/tool-policy.json (shared with scripts/verify/tool-drift.mjs).
 *  - A tool is exposed only if it is listed there (or added per org via extraAllow).
 *  - For built-in tools that take an `action` argument, ONLY the listed actions are
 *    accepted. Anything else, including a missing action, is rejected. A new or
 *    write-like upstream action (for example wit_backlog.reorder) can never slip through.
 *  - A mutation-verb regex remains as a second, independent layer.
 *  - extraAllow can never enable a tool whose name looks like a write tool.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PolicyFile {
  version: number;
  allowedActions: Record<string, string[]>;
  noActionTools: string[];
  reviewedBlockedActions: Record<string, string[]>;
}

// Same relative depth from src/ado (tsx, vitest) and dist/ado (built): ../../config
const policyFile = require("../../config/tool-policy.json") as PolicyFile;

export const ALLOWED_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...policyFile.allowedActions,
});

export const NO_ACTION_TOOLS: readonly string[] = Object.freeze([...policyFile.noActionTools]);

export const REVIEWED_BLOCKED_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...policyFile.reviewedBlockedActions,
});

export const DEFAULT_ALLOWLIST: readonly string[] = Object.freeze([
  ...Object.keys(ALLOWED_ACTIONS),
  ...NO_ACTION_TOOLS,
]);

export const ACTION_DENY_REGEX =
  /^(create|update|delete|remove|add|set|run|queue|retry|cancel|approve|vote|complete|abandon|reply|resolve|link|unlink|upsert|write|assign|merge|publish|trigger|reorder|move|rename|reset|restore|restart|stop|start|enable|disable|import|push|commit)/i;

/** For tools added via extraAllow (no reviewed action list): an action must look like a read. */
export const READ_ACTION_REGEX = /^(get|list|search|find|read|my|wiql|query)/i;

/** Tool names that must never be enabled through extraAllow. */
export const WRITE_TOOL_NAME_REGEX = /(^|_)(write|create|upsert|update|delete|remove|set)(_|$)/i;

export interface ToolPolicyConfig {
  extraAllow?: string[];
  extraDeny?: string[];
}

export function resolveAllowedTools(policy?: ToolPolicyConfig): Set<string> {
  const allowed = new Set<string>(DEFAULT_ALLOWLIST);
  for (const name of policy?.extraAllow ?? []) {
    if (!WRITE_TOOL_NAME_REGEX.test(name)) allowed.add(name);
  }
  for (const name of policy?.extraDeny ?? []) allowed.delete(name);
  return allowed;
}

export function isToolAllowed(toolName: string, policy?: ToolPolicyConfig): boolean {
  return resolveAllowedTools(policy).has(toolName);
}

/** Mutation-verb regex (second layer). */
export function isActionDenied(action: unknown): boolean {
  if (typeof action !== "string") return false;
  return ACTION_DENY_REGEX.test(action);
}

export type CallDecision =
  | { ok: true }
  | {
      ok: false;
      code: "tool_not_permitted" | "action_not_permitted";
      message: string;
    };

/** Full pre-flight check for a tools/call. */
export function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  policy?: ToolPolicyConfig,
): CallDecision {
  if (!isToolAllowed(toolName, policy)) {
    return {
      ok: false,
      code: "tool_not_permitted",
      message: `Tool not permitted: ${toolName}`,
    };
  }

  const action = args.action;
  const builtInActions = ALLOWED_ACTIONS[toolName];

  if (builtInActions) {
    if (typeof action !== "string" || !builtInActions.includes(action)) {
      return {
        ok: false,
        code: "action_not_permitted",
        message: `Action not permitted: ${
          typeof action === "string" ? action : "(missing)"
        }. Allowed for ${toolName}: ${builtInActions.join(", ")}`,
      };
    }
  } else if (action !== undefined) {
    // Extra-allowed or no-action tool handed an action: it must be a string that looks like a read.
    if (typeof action !== "string" || !READ_ACTION_REGEX.test(action)) {
      return {
        ok: false,
        code: "action_not_permitted",
        message: `Action not permitted: ${String(action)}`,
      };
    }
  }

  if (isActionDenied(action)) {
    return {
      ok: false,
      code: "action_not_permitted",
      message: `Action not permitted: ${String(action)}`,
    };
  }
  return { ok: true };
}

interface SchemaLike {
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Narrow the `action` enum advertised to the model to the permitted actions only,
 * so blocked actions (for example reorder) are not even shown. Never mutates input.
 */
export function sanitizeTool<T extends { name: string; inputSchema?: unknown }>(tool: T): T {
  const schema = tool.inputSchema as SchemaLike | undefined;
  const actionProp = schema?.properties?.action as
    { enum?: unknown; [k: string]: unknown } | undefined;
  if (!schema || !actionProp || !Array.isArray(actionProp.enum)) return tool;

  const builtIn = ALLOWED_ACTIONS[tool.name];
  const narrowed = (actionProp.enum as unknown[]).filter((v) => {
    if (typeof v !== "string") return false;
    if (builtIn) return builtIn.includes(v);
    return READ_ACTION_REGEX.test(v) && !ACTION_DENY_REGEX.test(v);
  });

  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        action: { ...actionProp, enum: narrowed },
      },
    },
  };
}

export function filterToolsByPolicy<T extends { name: string; inputSchema?: unknown }>(
  tools: T[],
  policy?: ToolPolicyConfig,
): T[] {
  const allowed = resolveAllowedTools(policy);
  return tools.filter((t) => allowed.has(t.name)).map((t) => sanitizeTool(t));
}
