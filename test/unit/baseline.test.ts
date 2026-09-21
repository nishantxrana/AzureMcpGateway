import { describe, expect, it } from "vitest";

describe("phase 0 baseline", () => {
  it("runs under Node 22+", () => {
    const major = Number(process.versions.node.split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
