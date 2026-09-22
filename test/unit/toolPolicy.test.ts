import { describe, expect, it } from "vitest";
import {
  ACTION_DENY_REGEX,
  ALLOWED_ACTIONS,
  DEFAULT_ALLOWLIST,
  REVIEWED_BLOCKED_ACTIONS,
  evaluateToolCall,
  filterToolsByPolicy,
  isActionDenied,
  isToolAllowed,
  resolveAllowedTools,
  sanitizeTool,
} from "../../src/ado/toolPolicy.js";

describe("tool allowlist", () => {
  it("default allowlist includes reads and excludes writes", () => {
    expect(isToolAllowed("core_list_projects")).toBe(true);
    expect(isToolAllowed("pipelines_write")).toBe(false);
    expect(isToolAllowed("repo_create_branch")).toBe(false);
    expect(isToolAllowed("fake_upstream_new_tool")).toBe(false);
    expect(DEFAULT_ALLOWLIST).toHaveLength(16);
  });

  it("honors extraAllow and extraDeny", () => {
    expect(isToolAllowed("pipelines_artifact", { extraAllow: ["pipelines_artifact"] })).toBe(true);
    expect(isToolAllowed("wiki", { extraDeny: ["wiki"] })).toBe(false);
  });

  it("extraAllow can never enable a write-looking tool", () => {
    const policy = {
      extraAllow: [
        "pipelines_write",
        "repo_create_branch",
        "wiki_upsert_page",
        "wit_work_item_write",
      ],
    };
    for (const name of policy.extraAllow) {
      expect(isToolAllowed(name, policy)).toBe(false);
    }
  });

  it("filters tool lists", () => {
    const tools = [
      { name: "core_list_projects" },
      { name: "pipelines_write" },
      { name: "fake_upstream_new_tool" },
    ];
    expect(filterToolsByPolicy(tools).map((t) => t.name)).toEqual(["core_list_projects"]);
  });

  it("resolveAllowedTools returns a set", () => {
    expect(resolveAllowedTools().has("wiki")).toBe(true);
  });
});

describe("action policy", () => {
  it("mutation regex still rejects mutation verbs and allows reads", () => {
    for (const a of ["create", "update", "run_pipeline", "vote", "reorder"]) {
      expect(isActionDenied(a)).toBe(true);
    }
    for (const a of ["list", "get", "list_wikis"]) {
      expect(isActionDenied(a)).toBe(false);
    }
    expect(ACTION_DENY_REGEX.test("list_wikis")).toBe(false);
  });

  it("no allowed action matches the mutation regex, and blocked ones are not allowed", () => {
    for (const [tool, actions] of Object.entries(ALLOWED_ACTIONS)) {
      for (const a of actions) {
        expect(isActionDenied(a), `${tool}.${a}`).toBe(false);
      }
    }
    for (const [tool, blocked] of Object.entries(REVIEWED_BLOCKED_ACTIONS)) {
      for (const a of blocked) {
        expect(ALLOWED_ACTIONS[tool]).not.toContain(a);
      }
    }
  });

  it("allows only listed actions on built-in tools", () => {
    expect(evaluateToolCall("wit_backlog", { action: "list" }).ok).toBe(true);
    expect(evaluateToolCall("pipelines_build", { action: "get_status" }).ok).toBe(true);
    expect(evaluateToolCall("wiki", { action: "list_wikis" }).ok).toBe(true);
  });

  it("rejects wit_backlog.reorder, unknown actions and a missing action", () => {
    const reorder = evaluateToolCall("wit_backlog", { action: "reorder" });
    expect(reorder.ok).toBe(false);
    // Not caught by the verb regex alone in the old design; the explicit list stops it.
    expect(evaluateToolCall("wit_backlog", { action: "future_new_action" }).ok).toBe(false);
    expect(evaluateToolCall("repo_repository", { action: "create" }).ok).toBe(false);
    expect(evaluateToolCall("repo_repository", {}).ok).toBe(false);
    expect(evaluateToolCall("repo_repository", { action: 42 }).ok).toBe(false);
  });

  it("no-action tools accept no action or a read-like one, reject the rest", () => {
    expect(evaluateToolCall("core_list_projects", {}).ok).toBe(true);
    expect(evaluateToolCall("core_list_projects", { action: "list" }).ok).toBe(true);
    expect(evaluateToolCall("core_list_projects", { action: "delete" }).ok).toBe(false);
    expect(evaluateToolCall("core_list_projects", { action: ["x"] }).ok).toBe(false);
  });

  it("denied tool reports tool_not_permitted", () => {
    const d = evaluateToolCall("pipelines_write", {});
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("tool_not_permitted");
  });
});

describe("sanitizeTool", () => {
  it("narrows the advertised action enum and does not mutate the input", () => {
    const tool = {
      name: "wit_backlog",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["list", "list_work_items", "reorder"] } },
      },
    };
    const before = JSON.stringify(tool);
    const out = sanitizeTool(tool);
    expect((out.inputSchema.properties.action as { enum: string[] }).enum).toEqual([
      "list",
      "list_work_items",
    ]);
    expect(JSON.stringify(tool)).toBe(before);
  });

  it("leaves tools without an action enum untouched", () => {
    const tool = { name: "core_list_projects", inputSchema: { type: "object", properties: {} } };
    expect(sanitizeTool(tool)).toBe(tool);
  });
});
