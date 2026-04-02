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
import { createHash } from "node:crypto";

import { openDb, searchPackages, getPackageDocs, getModuleDocs, lookupValue } from "./db.mjs";
import {
  formatPackageDocs,
  formatModuleDocs,
  formatLookupResults,
  formatSearchResults,
  formatTypeSearchResults,
} from "./format.mjs";
import { typeSearch } from "./elm-scripts.mjs";

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

function readDirectDeps(projectPath) {
  try {
    const elmJsonPath = join(projectPath, "elm.json");
    const elmJson = JSON.parse(readFileSync(elmJsonPath, "utf-8"));

    if (elmJson.type === "application") {
      return Object.keys(elmJson.dependencies?.direct || {});
    } else if (elmJson.type === "package") {
      return Object.keys(elmJson.dependencies || {});
    }
    return null;
  } catch {
    return null;
  }
}

function resolveProjectDeps(projectPath) {
  if (!projectPath) return null;

  const projectDir = existsSync(join(projectPath, "elm.json"))
    ? projectPath
    : findElmJsonDir(projectPath);

  if (!projectDir) return null;
  return readDirectDeps(projectDir);
}

function computeProjectDbPath(projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return resolve(homedir(), ".elm-docs", "projects", hash, "context.db");
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
          "Path to a directory containing elm.json. When provided, results are filtered to direct dependencies only.",
        ),
    },
    async ({ query, limit, project_path }) => {
      const db = openDb(dbPath);
      try {
        const allowedPackages = resolveProjectDeps(project_path);
        const results = searchPackages(db, { query, limit, allowedPackages });
        const text = formatSearchResults(results);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
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
          "Path to a directory containing elm.json. When provided, results are filtered to direct dependencies only.",
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
        .describe("Package identifier (e.g. 'elm/core', 'elm-community/list-extra')"),
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
    },
    async ({ package: pkg, version, compact }) => {
      const db = openDb(dbPath);
      try {
        const docs = getPackageDocs(db, { package: pkg, version });
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
        .describe("Package identifier (e.g. 'elm/core', 'elm/json')"),
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
    },
    async ({ package: pkg, module: moduleName, compact }) => {
      const db = openDb(dbPath);
      try {
        const result = getModuleDocs(db, { package: pkg, module: moduleName });
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
          "Path to a directory containing elm.json. When provided, results are filtered to direct dependencies only.",
        ),
    },
    async ({ name, project_path }) => {
      const db = openDb(dbPath);
      try {
        const allowedPackages = resolveProjectDeps(project_path);
        const results = lookupValue(db, { name, allowedPackages });
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for '${name}'.` }],
          };
        }
        const text = formatLookupResults(results);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
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
