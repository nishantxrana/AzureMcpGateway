/**
 * Response shaping: strip ADO noise, preserve UNTRUSTED envelope, size-cap.
 */

const ENVELOPE_RE =
  /^(<<[0-9a-f]+>> \[UNTRUSTED [^\]]*\] <<[0-9a-f]+>>)\n([\s\S]*)\n(<<\/[0-9a-f]+>>)\s*$/;

const REMOVE_KEYS = new Set([
  "_links",
  "avatar",
  "imageUrl",
  "descriptor",
  "drafts",
  "plans",
  "triggerInfo",
  "validationResults",
  "orchestrationPlan",
  "retainedByRelease",
  "appendCommitMessageToRunName",
  "badge",
]);

export interface ShapeResult {
  texts: string[];
  truncated: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentityObject(value: Record<string, unknown>): boolean {
  return typeof value.displayName === "string" && typeof value.uniqueName === "string";
}

function isProjectObject(value: Record<string, unknown>): boolean {
  return (
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.name === "string" &&
    ("url" in value || "state" in value || "visibility" in value)
  );
}

function cleanValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => cleanValue(item)).filter((item) => item !== undefined);
    return cleaned.length === 0 ? undefined : cleaned;
  }
  if (!isPlainObject(value)) return value;

  if (isIdentityObject(value)) {
    return {
      displayName: value.displayName,
      uniqueName: value.uniqueName,
    };
  }

  if (isProjectObject(value) && !("buildNumber" in value)) {
    return { id: value.id, name: value.name };
  }

  const out: Record<string, unknown> = {};

  if (
    isPlainObject(value._links) &&
    isPlainObject(value._links.web) &&
    typeof value._links.web.href === "string" &&
    value.webUrl === undefined
  ) {
    out.webUrl = value._links.web.href;
  }

  for (const [k, v] of Object.entries(value)) {
    if (REMOVE_KEYS.has(k)) continue;
    if (k === "properties" && isPlainObject(v) && Object.keys(v).length === 0) {
      continue;
    }
    const cleaned = cleanValue(v);
    if (cleaned === undefined) continue;
    if (Array.isArray(cleaned) && cleaned.length === 0) continue;
    if (isPlainObject(cleaned) && Object.keys(cleaned).length === 0) continue;
    out[k] = cleaned;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

function shapePayload(payload: unknown): unknown {
  const cleaned = cleanValue(payload);
  return cleaned === undefined ? (Array.isArray(payload) ? [] : {}) : cleaned;
}

function wrapEnvelope(header: string, footer: string, body: string): string {
  return `${header}\n${body}\n${footer}`;
}

const TRUNCATION_NOTE =
  "Output truncated: returned N of M items. Narrow the query (smaller top, specific project, date range).";

function truncationNote(n: number, m: number): string {
  return TRUNCATION_NOTE.replace("N", String(n)).replace("M", String(m));
}

function applySizeCap(text: string, maxChars: number, originalPayload: unknown): ShapeResult {
  if (text.length <= maxChars) {
    return { texts: [text], truncated: false };
  }

  const match = text.match(ENVELOPE_RE);
  if (match && Array.isArray(originalPayload)) {
    const header = match[1]!;
    const footer = match[3]!;
    let lo = 0;
    let hi = originalPayload.length;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const slice = originalPayload.slice(0, mid);
      const candidate = wrapEnvelope(header, footer, JSON.stringify(slice));
      if (candidate.length <= maxChars) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const kept = originalPayload.slice(0, best);
    const body = wrapEnvelope(header, footer, JSON.stringify(kept));
    return {
      texts: [body, truncationNote(best, originalPayload.length)],
      truncated: true,
    };
  }

  if (match) {
    const header = match[1]!;
    const footer = match[3]!;
    const overhead = header.length + footer.length + 2;
    const budget = Math.max(0, maxChars - overhead);
    const truncatedPayload = match[2]!.slice(0, budget);
    return {
      texts: [wrapEnvelope(header, footer, truncatedPayload), truncationNote(1, 1)],
      truncated: true,
    };
  }

  return {
    texts: [text.slice(0, maxChars), truncationNote(1, 1)],
    truncated: true,
  };
}

/**
 * Shape a single text content block. Returns one or more text blocks
 * (second block is truncation note when capped).
 */
export function shapeText(text: string, maxResponseChars = 60_000): ShapeResult {
  const match = text.match(ENVELOPE_RE);
  if (!match) {
    return applySizeCap(text, maxResponseChars, undefined);
  }

  const header = match[1]!;
  const payloadRaw = match[2]!;
  const footer = match[3]!;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadRaw) as unknown;
  } catch {
    return applySizeCap(text, maxResponseChars, undefined);
  }

  const shaped = shapePayload(parsed);
  const compact = JSON.stringify(shaped);
  const wrapped = wrapEnvelope(header, footer, compact);
  return applySizeCap(wrapped, maxResponseChars, shaped);
}

export function shapeToolResult(
  result: {
    content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
    [k: string]: unknown;
  },
  maxResponseChars = 60_000,
): {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  truncated: boolean;
} {
  const isError = result.isError;
  let truncated = false;
  const content: Array<{ type: string; text?: string; [k: string]: unknown }> = [];

  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      const shaped = shapeText(block.text, maxResponseChars);
      truncated = truncated || shaped.truncated;
      for (const t of shaped.texts) {
        content.push({ type: "text", text: t });
      }
    } else {
      content.push(block);
    }
  }

  const out: {
    content: Array<{ type: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
    truncated: boolean;
  } = { content, truncated };
  if (isError !== undefined) out.isError = isError;
  return out;
}
