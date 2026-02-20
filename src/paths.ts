import { dirname, resolve, parse } from "path";

/**
 * Resolve the project root directory.
 *
 * When running from source (bun run src/commander.ts), Bun.main is the .ts
 * file so we go up two directories (src/ -> repo root).
 *
 * When running as a compiled binary, Bun.main may return an internal virtual
 * path (e.g. "/" on Windows) instead of the real executable path. We use
 * process.execPath as the primary source for compiled binaries, falling back
 * to process.cwd() if that also fails.
 */
export function resolveProjectRoot(bunMain: string, execPath: string, cwd: string): string {
  const isSource = bunMain.endsWith(".ts") || bunMain.endsWith(".js");

  if (isSource) {
    return dirname(dirname(bunMain));
  }

  // Compiled binary: prefer process.execPath over Bun.main since Bun.main
  // may return a virtual filesystem path in compiled binaries.
  // Try execPath first, then bunMain, then fall back to cwd.
  for (const candidate of [execPath, bunMain]) {
    if (candidate) {
      const dir = dirname(resolve(candidate));
      // Sanity check: reject root-only paths (e.g. "/" or "\" or "C:\")
      if (!isRootPath(dir)) {
        return dir;
      }
    }
  }

  // Last resort: use current working directory
  return cwd;
}

/**
 * Check if a path is a filesystem root (e.g. "/", "\", "C:\", "D:/").
 * We never want to use a root as PROJECT_ROOT since creating subdirectories
 * there will fail with permission errors.
 *
 * Works cross-platform: handles both "/" (posix) and "\" / "C:\" (Windows).
 */
export function isRootPath(p: string): boolean {
  if (!p) return true;

  // Normalize: trim trailing separators for comparison
  const normalized = p.replace(/[/\\]+$/, "");

  // Empty after stripping means it was purely slashes (e.g. "/" or "\")
  if (normalized === "") return true;

  // Windows drive root: "C:" or "D:" (after stripping trailing separator)
  if (/^[A-Za-z]:$/.test(normalized)) return true;

  // Use path.parse as additional check (works for the native platform)
  const parsed = parse(p);
  if (parsed.base === "" || p === parsed.root) return true;

  return false;
}
