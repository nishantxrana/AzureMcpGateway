import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: "", stderr: "" })));
vi.mock("node:child_process", () => ({ spawnSync }));

// @ts-expect-error plain-JS helper without type declarations
const lib = (await import("../../scripts/verify/_lib.mjs")) as {
  runCommand: (cmd: string, args?: string[], opts?: object) => unknown;
  describeFailure: (r: object, max?: number) => string;
};

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value });
}

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  delete process.env.npm_execpath;
  spawnSync.mockClear();
});

describe("runCommand (the Windows 'exit null' bug)", () => {
  it("win32: npm runs through node + npm_execpath, never through a .cmd shim", () => {
    setPlatform("win32");
    process.env.npm_execpath = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    lib.runCommand("npm", ["run", "lint"]);
    const [cmd, args, opts] = spawnSync.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([process.env.npm_execpath, "run", "lint"]);
    expect(opts.shell).toBe(false);
  });

  it("win32: az uses a shell with one quoted command string", () => {
    setPlatform("win32");
    lib.runCommand("az", ["keyvault", "secret", "show", "--name", "my secret"]);
    const [cmd, args, opts] = spawnSync.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(opts.shell).toBe(true);
    expect(args).toEqual([]);
    expect(cmd).toBe('az keyvault secret show --name "my secret"');
  });

  it("win32: npm without npm_execpath still works via the shell", () => {
    setPlatform("win32");
    lib.runCommand("npm", ["test"]);
    const [cmd, , opts] = spawnSync.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(opts.shell).toBe(true);
    expect(cmd).toBe("npm test");
  });

  it("win32: real executables (git, node) are spawned directly, no shell", () => {
    setPlatform("win32");
    lib.runCommand("git", ["rev-parse", "--short", "HEAD"]);
    const [cmd, args, opts] = spawnSync.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(cmd).toBe("git");
    expect(args).toEqual(["rev-parse", "--short", "HEAD"]);
    expect(opts.shell).toBe(false);
  });

  it("linux: everything is spawned directly with shell disabled", () => {
    setPlatform("linux");
    lib.runCommand("az", ["version"]);
    const [cmd, , opts] = spawnSync.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(cmd).toBe("az");
    expect(opts.shell).toBe(false);
  });

  it("describeFailure surfaces a spawn error instead of a bare 'exit null'", () => {
    const msg = lib.describeFailure({ status: null, error: new Error("spawn npm ENOENT") });
    expect(msg).toContain("ENOENT");
    expect(msg).not.toBe("exit null");
  });
});
