import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shapeText, shapeToolResult } from "../../src/ado/shape.js";

const fixturePath = join(
  process.cwd(),
  "test/fixtures/pipelines_build.list.sample.txt",
);

describe("shapeText", () => {
  it("reduces fixture by at least 60% and preserves envelope + fields", () => {
    const raw = readFileSync(fixturePath, "utf8").replace(/\r\n/g, "\n").trimEnd();
    const result = shapeText(raw, 60_000);
    expect(result.texts[0]).toBeTruthy();
    const shaped = result.texts[0]!;
    const reduction = 1 - shaped.length / raw.length;
    expect(reduction).toBeGreaterThanOrEqual(0.6);

    expect(shaped.startsWith("<<")).toBe(true);
    expect(shaped).toContain("[UNTRUSTED AZURE DEVOPS");
    expect(shaped).toMatch(/<<\/[0-9a-f]+>>/);

    const payloadMatch = shaped.match(
      /^<<[0-9a-f]+>> \[UNTRUSTED [^\]]*\] <<[0-9a-f]+>>\n([\s\S]*)\n<<\/[0-9a-f]+>>\s*$/,
    );
    expect(payloadMatch).toBeTruthy();
    const payload = JSON.parse(payloadMatch![1]!) as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    const first = payload[0]!;
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("buildNumber");
    expect(first).toHaveProperty("status");
    expect(first).toHaveProperty("result");
    expect(first).toHaveProperty("sourceBranch");
    expect(first).toHaveProperty("webUrl");
    expect(first).not.toHaveProperty("_links");
    expect(first).not.toHaveProperty("plans");
  });

  it("passes through non-envelope text", () => {
    const r = shapeText("hello world", 1000);
    expect(r.texts[0]).toBe("hello world");
  });

  it("passes through non-JSON envelope payload", () => {
    const id = "aabbcc";
    const text = `<<${id}>> [UNTRUSTED AZURE DEVOPS X CONTENT] <<${id}>>\nnot-json\n<</${id}>>`;
    const r = shapeText(text, 1000);
    expect(r.texts[0]).toBe(text);
  });

  it("truncates oversized arrays with a second block", () => {
    const id = "aabbccddeeff00112233445566778899";
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `item-${i}-${"x".repeat(200)}`,
    }));
    const text = `<<${id}>> [UNTRUSTED AZURE DEVOPS X CONTENT] <<${id}>>\n${JSON.stringify(items)}\n<</${id}>>`;
    const r = shapeText(text, 2_000);
    expect(r.truncated).toBe(true);
    expect(r.texts.length).toBe(2);
    expect(r.texts[1]).toMatch(/Output truncated/);
  });

  it("preserves isError on tool results", () => {
    const r = shapeToolResult(
      {
        isError: true,
        content: [{ type: "text", text: "boom" }],
      },
      1000,
    );
    expect(r.isError).toBe(true);
  });

  it("fuzz: 200 random payloads never throw or grow", () => {
    for (let i = 0; i < 200; i++) {
      const id = "deadbeefdeadbeefdeadbeefdeadbeef";
      const payload = randomJson(i);
      const raw = JSON.stringify(payload);
      const text = `<<${id}>> [UNTRUSTED AZURE DEVOPS FUZZ CONTENT] <<${id}>>\n${raw}\n<</${id}>>`;
      const shaped = shapeText(text, 60_000);
      expect(shaped.texts[0]!.length).toBeLessThanOrEqual(text.length);
    }
  });
});

function randomJson(seed: number): unknown {
  const roll = seed % 7;
  if (roll === 0) return null;
  if (roll === 1) return "str";
  if (roll === 2) return seed;
  if (roll === 3) return [];
  if (roll === 4) return { a: 1, _links: { web: { href: "https://x" } } };
  if (roll === 5)
    return [
      {
        id: seed,
        project: {
          id: "1",
          name: "P",
          url: "u",
          state: "wellFormed",
        },
        displayName: "N",
        uniqueName: "u@x",
        avatar: { url: "x" },
      },
    ];
  return {
    nested: { plans: [], drafts: [], keep: true },
    properties: {},
  };
}
