import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

describe("smoke", () => {
  it("loadEnv defaults", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.PORT).toBe(8080);
    expect(env.CHILD_TIMEOUT_MS).toBe(60_000);
    expect(env.MAX_CONCURRENT_CHILDREN).toBe(6);
  });
});
