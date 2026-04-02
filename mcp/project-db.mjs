/**
 * Shared helpers for building and managing per-project context databases.
 * Used by both the MCP server and the CLI dispatcher.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, globSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

import { resolveElmPages, scriptsDir } from "./elm-scripts.mjs";

/**
 * Compute the path to the project context database.
 */
export function computeProjectDbPath(projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return resolve(homedir(), ".elm-docs", "projects", hash, "context.db");
}

/**
 * Get source directories from elm.json.
 */
export function getElmJsonSourceDirs(projectRoot) {
  try {
    const data = JSON.parse(readFileSync(join(projectRoot, "elm.json"), "utf-8"));
    if (data.type === "application") {
      return (data["source-directories"] || ["src"]).map((d) => resolve(projectRoot, d));
    }
    return [resolve(projectRoot, "src")];
  } catch {
    return [resolve(projectRoot, "src")];
  }
}

/**
 * Check whether the project context database needs rebuilding.
 */
export function isProjectDbStale(projectDbPath, projectRoot) {
  if (!existsSync(projectDbPath)) return true;
  const dbMtime = statSync(projectDbPath).mtimeMs;

  // Check elm.json
  const elmJsonPath = join(projectRoot, "elm.json");
  if (statSync(elmJsonPath).mtimeMs > dbMtime) return true;

  // Check source files
  const sourceDirs = getElmJsonSourceDirs(projectRoot);
  for (const srcDir of sourceDirs) {
    if (!existsSync(srcDir)) continue;
    const files = globSync("**/*.elm", { cwd: srcDir });
    for (const f of files) {
      if (statSync(join(srcDir, f)).mtimeMs > dbMtime) return true;
    }
  }

  return false;
}

// Per-project build lock to prevent concurrent builds
const buildLocks = new Map();

/**
 * Build the project context database if stale (async version).
 * Captures stdout/stderr to avoid corrupting MCP stdio transport.
 * Returns { ok: true } on success, or { ok: false, error: string } on failure.
 */
export async function ensureProjectDb(projectDbPath, projectRoot) {
  if (!isProjectDbStale(projectDbPath, projectRoot)) return { ok: true };

  // Acquire per-project lock to prevent concurrent builds
  const existing = buildLocks.get(projectRoot);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const dbDir = dirname(projectDbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      await new Promise((resolve, reject) => {
        execFile(
          resolveElmPages(),
          [
            "run", "src/BuildProjectContext.elm", "--",
            "--project-root", projectRoot,
            "--db", projectDbPath,
          ],
          { cwd: scriptsDir, timeout: 60000 },
          (err, _stdout, stderr) => {
            if (err) {
              const msg = stderr ? `${err.message}\n${stderr}` : err.message;
              reject(new Error(msg));
            } else {
              resolve();
            }
          },
        );
      });

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      buildLocks.delete(projectRoot);
    }
  })();

  buildLocks.set(projectRoot, promise);
  return promise;
}
