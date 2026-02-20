import { describe, test, expect } from "bun:test";
import { resolveProjectRoot, isRootPath } from "./paths.js";

describe("isRootPath", () => {
  test("detects Unix root /", () => {
    expect(isRootPath("/")).toBe(true);
  });

  test("detects backslash root (Windows)", () => {
    expect(isRootPath("\\")).toBe(true);
  });

  test("detects Windows drive roots", () => {
    expect(isRootPath("C:\\")).toBe(true);
    expect(isRootPath("D:\\")).toBe(true);
    expect(isRootPath("C:")).toBe(true);
  });

  test("detects empty string as root-like", () => {
    expect(isRootPath("")).toBe(true);
  });

  test("detects multiple slashes as root", () => {
    expect(isRootPath("//")).toBe(true);
    expect(isRootPath("\\\\")).toBe(true);
  });

  test("rejects normal directories", () => {
    expect(isRootPath("/home/user/project")).toBe(false);
    expect(isRootPath("/Users/clodpod/projects")).toBe(false);
    expect(isRootPath("E:\\code\\commander")).toBe(false);
  });
});

describe("resolveProjectRoot", () => {
  test("uses dirname(dirname(Bun.main)) for source .ts files", () => {
    const result = resolveProjectRoot(
      "/home/user/commander/src/commander.ts",
      "/usr/bin/bun",
      "/home/user"
    );
    expect(result).toBe("/home/user/commander");
  });

  test("uses dirname(dirname(Bun.main)) for source .js files", () => {
    const result = resolveProjectRoot(
      "/home/user/commander/src/commander.js",
      "/usr/bin/bun",
      "/home/user"
    );
    expect(result).toBe("/home/user/commander");
  });

  test("uses execPath for compiled binary", () => {
    const result = resolveProjectRoot(
      "/internal/bundle",  // Bun.main in compiled binary (not .ts/.js)
      "/home/user/commander/commander-linux-x64",
      "/home/user"
    );
    expect(result).toBe("/home/user/commander");
  });

  test("BUG REPRO: does NOT return root when Bun.main is '/' in compiled binary", () => {
    // This is the exact bug: on Windows compiled binaries, Bun.main returns "/"
    // which causes dirname("/") -> "\" on Windows, leading to mkdir("\") -> EPERM
    const result = resolveProjectRoot(
      "/",  // Bun.main returns "/" in compiled binary on Windows
      "/home/user/commander/commander-exe",  // but execPath is valid
      "/home/user"
    );
    // Should NOT be "/" or "\" — should use execPath instead
    expect(isRootPath(result)).toBe(false);
    expect(result).toBe("/home/user/commander");
  });

  test("falls back to cwd when both Bun.main and execPath are root paths", () => {
    const result = resolveProjectRoot(
      "/",
      "/",
      "/home/user/commander"
    );
    expect(result).toBe("/home/user/commander");
  });

  test("falls back to cwd when both paths are empty", () => {
    const result = resolveProjectRoot(
      "",
      "",
      "/home/user/commander"
    );
    expect(result).toBe("/home/user/commander");
  });
});
