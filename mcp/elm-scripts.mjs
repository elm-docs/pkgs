/**
 * Abstraction over elm-pages script execution.
 * All MCP tools that need Elm call through this module.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const scriptsDir = resolve(pkgRoot, "scripts");

function resolveElmPages() {
  const local = resolve(pkgRoot, "node_modules", ".bin", "elm-pages");
  if (existsSync(local)) return local;
  return "elm-pages";
}

/**
 * Run a type search query via elm-pages and return parsed JSON results.
 *
 * @param {object} options
 * @param {string} options.dbPath - Path to the SQLite database
 * @param {string} options.query - Type signature to search for
 * @param {number} [options.limit=20] - Max results
 * @param {string} [options.projectRoot] - Path to project directory for scoped search
 * @param {string} [options.projectDb] - Path to project context database
 * @returns {Promise<Array<{package: string, module: string, name: string, kind: string, typeRaw: string, distance: number}>>}
 */
export function typeSearch({ dbPath, query, limit = 20, projectRoot, projectDb }) {
  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "src/TypeSearch.elm",
      "--",
      "--db", dbPath,
      "--json",
      "--limit", String(limit),
      query,
    ];

    if (projectRoot) {
      args.push("--project-root", projectRoot);
    }
    if (projectDb) {
      args.push("--project-db", projectDb);
    }

    execFile(resolveElmPages(), args, { cwd: scriptsDir, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        // Include stderr for debugging
        const msg = stderr ? `${err.message}\n${stderr}` : err.message;
        reject(new Error(msg));
        return;
      }

      try {
        // elm-pages may print timing/debug lines before the JSON array.
        // Extract the JSON by finding the first '[' character.
        const jsonStart = stdout.indexOf("[");
        if (jsonStart === -1) {
          reject(new Error(`No JSON array in type search output: ${stdout.slice(0, 200)}`));
          return;
        }
        const results = JSON.parse(stdout.slice(jsonStart));
        resolve(results);
      } catch {
        reject(new Error(`Failed to parse type search output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}
