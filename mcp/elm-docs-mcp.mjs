#!/usr/bin/env node

/**
 * MCP server for Elm package documentation.
 *
 * Exposes tools for searching packages, looking up APIs, browsing docs,
 * and searching by type signature. Designed to prevent LLM hallucination
 * of Elm APIs by providing exact data from the package database.
 *
 * Usage:
 *   node mcp/elm-docs-mcp.mjs [--db <path>]
 *   elm-docs mcp [--db <path>]
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { openDb, searchPackages, getPackageDocs, getModuleDocs, lookupValue } from "./db.mjs";
import {
  formatPackageDocs,
  formatModuleDocs,
  formatLookupResults,
  formatSearchResults,
  formatTypeSearchResults,
} from "./format.mjs";
import { typeSearch } from "./elm-scripts.mjs";
import { computeProjectDbPath, ensureProjectDb } from "./project-db.mjs";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let dbPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db" && i + 1 < argv.length) {
      dbPath = argv[++i];
    }
  }
  return { dbPath: dbPath || resolve(homedir(), ".elm-docs", "elm-packages.db") };
}

// ---------------------------------------------------------------------------
// Project scope helpers
// ---------------------------------------------------------------------------

function findElmJsonDir(dir) {
  const elmJsonPath = join(dir, "elm.json");
  if (existsSync(elmJsonPath)) return dir;
  const parent = dirname(dir);
  if (parent === dir) return null;
  return findElmJsonDir(parent);
}

/**
 * Read direct dependencies from elm.json.
 * Returns array of { name, version, majorVersion } or null on error.
 * For applications: version is the exact pinned version.
 * For packages: version is null (range constraints can't be pinned).
 */
function readDirectDeps(projectPath) {
  try {
    const elmJsonPath = join(projectPath, "elm.json");
    const elmJson = JSON.parse(readFileSync(elmJsonPath, "utf-8"));

    if (elmJson.type === "application") {
      const deps = elmJson.dependencies?.direct || {};
      return Object.entries(deps).map(([name, version]) => ({
        name,
        version,
        majorVersion: parseInt(version.split(".")[0], 10),
      }));
    } else if (elmJson.type === "package") {
      const deps = elmJson.dependencies || {};
      return Object.entries(deps).map(([name, constraint]) => ({
        name,
        version: null,
        majorVersion: parseInt(constraint, 10),
      }));
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the MCP server with the given database path.
 * Exported for use by bin/elm-docs.mjs.
 */
export async function startMcpServer(dbPath) {

  const server = new McpServer({
    name: "elm-docs",
    version: "0.1.0",
  });

  // -------------------------------------------------------------------------
  // Tool: search_packages
  // -------------------------------------------------------------------------

  server.tool(
    "search_packages",
    "Search Elm packages by keyword. Matches against package name, author, and summary. Returns results ranked by popularity.",
    {
      query: z.string().describe("Search keywords (e.g. 'json parser', 'http', 'animation')"),
      limit: z.number().optional().default(20).describe("Maximum number of results (default: 20)"),
      project_path: z
        .string()
        .optional()
        .describe(
          "Path to a directory containing elm.json. When provided, results are filtered to direct dependencies and local project modules.",
        ),
    },
    async ({ query, limit, project_path }) => {
      const db = await openDb(dbPath);
      let projectDb = null;
      try {
        let allowedPackages = null;
        if (project_path) {
          const projectDir = existsSync(join(project_path, "elm.json"))
            ? project_path
            : findElmJsonDir(project_path);
          if (projectDir) {
            const deps = readDirectDeps(projectDir);
            if (deps) allowedPackages = deps.map((d) => d.name);
            const projectDbPath = computeProjectDbPath(projectDir);
            await ensureProjectDb(projectDbPath, projectDir);
            if (existsSync(projectDbPath)) {
              projectDb = await openDb(projectDbPath);
            }
          }
        }
        const results = searchPackages(db, { query, limit, allowedPackages, projectDb });
        const text = formatSearchResults(results);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
        if (projectDb) projectDb.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: type_search
  // -------------------------------------------------------------------------

  server.tool(
    "type_search",
    "Search for Elm functions by type signature. Uses structural matching with normalization — variable names don't matter, argument order is flexible. Great for finding functions when you know what types go in and come out.",
    {
      query: z
        .string()
        .describe(
          "Elm type signature to search for (e.g. 'List a -> Maybe a', 'String -> Int', '(a -> b) -> List a -> List b')",
        ),
      limit: z.number().optional().default(20).describe("Maximum number of results (default: 20)"),
      project_path: z
        .string()
        .optional()
        .describe(
          "Path to a directory containing elm.json. When provided, results are filtered to direct dependencies and local project modules.",
        ),
    },
    async ({ query, limit, project_path }) => {
      try {
        const opts = { dbPath, query, limit };

        if (project_path) {
          const projectDir = existsSync(join(project_path, "elm.json"))
            ? project_path
            : findElmJsonDir(project_path);

          if (projectDir) {
            opts.projectRoot = projectDir;
            const projectDbPath = computeProjectDbPath(projectDir);
            await ensureProjectDb(projectDbPath, projectDir);
            if (existsSync(projectDbPath)) {
              opts.projectDb = projectDbPath;
            }
          }
        }

        const results = await typeSearch(opts);
        const text = formatTypeSearchResults(results);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Type search failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_package_docs
  // -------------------------------------------------------------------------

  server.tool(
    "get_package_docs",
    "Get full documentation for an Elm package. Returns all modules with their types, functions, and documentation comments. Use compact mode for an API overview without prose.",
    {
      package: z
        .string()
        .describe("Package identifier (e.g. 'elm/core', 'elm-community/list-extra', 'local/app')"),
      version: z
        .string()
        .optional()
        .describe("Specific version (default: latest)"),
      compact: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, show only type signatures without documentation comments. Useful for fitting more into context.",
        ),
      project_path: z
        .string()
        .optional()
        .describe(
          "Path to a directory containing elm.json. Required when browsing local project modules (e.g. 'local/app').",
        ),
    },
    async ({ package: pkg, version, compact, project_path }) => {
      const db = await openDb(dbPath);
      let projectDb = null;
      try {
        let effectiveVersion = version;
        if (project_path) {
          const projectDir = existsSync(join(project_path, "elm.json"))
            ? project_path
            : findElmJsonDir(project_path);
          if (projectDir) {
            // When no explicit version given, use the pinned version from elm.json
            if (!version) {
              const deps = readDirectDeps(projectDir);
              if (deps) {
                const dep = deps.find((d) => d.name === pkg);
                if (dep && dep.version) effectiveVersion = dep.version;
              }
            }
            const projectDbPath = computeProjectDbPath(projectDir);
            await ensureProjectDb(projectDbPath, projectDir);
            if (existsSync(projectDbPath)) {
              projectDb = await openDb(projectDbPath);
            }
          }
        }
        const docs = getPackageDocs(db, { package: pkg, version: effectiveVersion, projectDb });
        if (!docs) {
          return {
            content: [
              {
                type: "text",
                text: `Package '${pkg}'${version ? ` version ${version}` : ""} not found.`,
              },
            ],
            isError: true,
          };
        }
        const text = formatPackageDocs(docs, { compact });
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
        if (projectDb) projectDb.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_module_docs
  // -------------------------------------------------------------------------

  server.tool(
    "get_module_docs",
    "Get documentation for a specific module within an Elm package. Returns the module's types, functions, and documentation comments.",
    {
      package: z
        .string()
        .describe("Package identifier (e.g. 'elm/core', 'elm/json', 'local/app')"),
      module: z
        .string()
        .describe("Module name (e.g. 'List', 'Json.Decode', 'Html.Attributes')"),
      compact: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, show only type signatures without documentation comments.",
        ),
      project_path: z
        .string()
        .optional()
        .describe(
          "Path to a directory containing elm.json. Required when browsing local project modules (e.g. 'local/app').",
        ),
    },
    async ({ package: pkg, module: moduleName, compact, project_path }) => {
      const db = await openDb(dbPath);
      let projectDb = null;
      try {
        let pinnedVersion = null;
        if (project_path) {
          const projectDir = existsSync(join(project_path, "elm.json"))
            ? project_path
            : findElmJsonDir(project_path);
          if (projectDir) {
            const deps = readDirectDeps(projectDir);
            if (deps) {
              const dep = deps.find((d) => d.name === pkg);
              if (dep && dep.version) pinnedVersion = dep.version;
            }
            const projectDbPath = computeProjectDbPath(projectDir);
            await ensureProjectDb(projectDbPath, projectDir);
            if (existsSync(projectDbPath)) {
              projectDb = await openDb(projectDbPath);
            }
          }
        }
        const result = getModuleDocs(db, { package: pkg, module: moduleName, version: pinnedVersion, projectDb });
        if (!result) {
          return {
            content: [
              {
                type: "text",
                text: `Module '${moduleName}' not found in package '${pkg}'.`,
              },
            ],
            isError: true,
          };
        }
        const text = formatModuleDocs(result, { compact });
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
        if (projectDb) projectDb.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: lookup_value
  // -------------------------------------------------------------------------

  server.tool(
    "lookup_value",
    "Look up an Elm function, type, or operator by name. Accepts qualified names like 'List.map', 'Json.Decode.field', or fully-qualified 'elm/core:List.map'. Returns type signatures, documentation, and package context.",
    {
      name: z
        .string()
        .describe(
          "Name to look up. Examples: 'map', 'List.map', 'Json.Decode.field', 'elm/core:List.map'",
        ),
      project_path: z
        .string()
        .optional()
        .describe(
          "Path to a directory containing elm.json. When provided, results are filtered to direct dependencies and local project modules.",
        ),
    },
    async ({ name, project_path }) => {
      const db = await openDb(dbPath);
      let projectDb = null;
      try {
        let allowedPackages = null;
        let dependencyVersions = null;
        if (project_path) {
          const projectDir = existsSync(join(project_path, "elm.json"))
            ? project_path
            : findElmJsonDir(project_path);
          if (projectDir) {
            const deps = readDirectDeps(projectDir);
            if (deps) {
              allowedPackages = deps.map((d) => d.name);
              dependencyVersions = new Map(
                deps.filter((d) => d.version).map((d) => [d.name, d.version]),
              );
            }
            const projectDbPath = computeProjectDbPath(projectDir);
            await ensureProjectDb(projectDbPath, projectDir);
            if (existsSync(projectDbPath)) {
              projectDb = await openDb(projectDbPath);
            }
          }
        }
        const results = lookupValue(db, { name, allowedPackages, dependencyVersions, projectDb });
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for '${name}'.` }],
          };
        }
        const text = formatLookupResults(results);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
        if (projectDb) projectDb.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Start server
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// When run directly (not imported by bin/elm-docs.mjs)
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] === __filename) {
  const { dbPath } = parseArgs(process.argv.slice(2));
  if (!existsSync(dbPath)) {
    console.error(
      `Database not found at ${dbPath}. Run 'elm-docs sync' to download it.`,
    );
    process.exit(1);
  }
  startMcpServer(dbPath).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
