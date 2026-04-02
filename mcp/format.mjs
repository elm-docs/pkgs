/**
 * Markdown formatting for Elm package documentation.
 * Shared between MCP server and (future) llms.txt generator.
 */

/**
 * Format full package documentation as Markdown.
 * @param {object} docs - Result from db.getPackageDocs()
 * @param {boolean} compact - If true, signatures only (no prose comments)
 */
export function formatPackageDocs(docs, { compact = false } = {}) {
  const lines = [`# ${docs.package} ${docs.version}`, ""];

  for (const mod of docs.modules) {
    lines.push(...formatModuleLines(mod, docs.package, { compact }));
  }

  return lines.join("\n");
}

/**
 * Format a single module's documentation as Markdown.
 * @param {object} result - Result from db.getModuleDocs()
 * @param {boolean} compact - If true, signatures only (no prose comments)
 */
export function formatModuleDocs(result, { compact = false } = {}) {
  const lines = [`# ${result.package} ${result.version}`, ""];
  lines.push(...formatModuleLines(result.module, result.package, { compact }));
  return lines.join("\n");
}

/**
 * Format lookup results as Markdown.
 * @param {object[]} results - Results from db.lookupValue()
 */
export function formatLookupResults(results) {
  if (results.length === 0) return "No results found.";

  const lines = [];
  for (const r of results) {
    const qualifiedName = `${r.module}.${r.name}`;
    lines.push(`## ${qualifiedName}`);
    lines.push(`*${r.package}*`);
    lines.push("");

    if (r.kind === "value") {
      lines.push("```elm", `${r.name} : ${r.type}`, "```");
    } else if (r.kind === "alias") {
      const args = JSON.parse(r.args);
      const argsStr = args.length > 0 ? " " + args.join(" ") : "";
      lines.push("```elm", `type alias ${r.name}${argsStr} = ${r.type}`, "```");
    } else if (r.kind === "union") {
      const args = JSON.parse(r.args);
      const cases = JSON.parse(r.cases);
      const argsStr = args.length > 0 ? " " + args.join(" ") : "";
      if (cases.length === 0) {
        lines.push("```elm", `type ${r.name}${argsStr}`, "```");
      } else {
        const casesStr = cases
          .map(([tag, types]) => `${tag}${types.length > 0 ? " " + types.join(" ") : ""}`)
          .join("\n    | ");
        lines.push("```elm", `type ${r.name}${argsStr}`, `    = ${casesStr}`, "```");
      }
    } else if (r.kind === "binop") {
      lines.push(
        "```elm",
        `(${r.name}) : ${r.type}`,
        "```",
        `*${r.associativity} ${r.precedence}*`,
      );
    }

    if (r.comment) {
      lines.push("", r.comment);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format search results as Markdown.
 */
export function formatSearchResults(results) {
  if (results.length === 0) return "No packages found.";

  const lines = [];
  for (const r of results) {
    const stars = r.stars > 0 ? ` (${r.stars} stars)` : "";
    lines.push(`- **${r.package}**${stars}: ${r.summary}`);
  }
  return lines.join("\n");
}

/**
 * Format type search results as Markdown.
 */
export function formatTypeSearchResults(results) {
  if (results.length === 0) return "No results found.";

  const lines = [];
  for (const r of results) {
    lines.push(
      `- **${r.module}.${r.name}** *${r.package}*`,
      `  \`${r.typeRaw}\`  [distance: ${r.distance.toFixed(3)}]`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatModuleLines(mod, pkg, { compact }) {
  const lines = [];
  lines.push(`## ${mod.name}`);
  lines.push("");

  if (!compact && mod.comment) {
    lines.push(mod.comment, "");
  }

  // Unions
  for (const u of mod.unions) {
    const argsStr = u.args.length > 0 ? " " + u.args.join(" ") : "";

    if (u.cases.length === 0) {
      // Opaque type — no exposed constructors
      lines.push("```elm", `type ${u.name}${argsStr}`, "```");
    } else {
      const casesStr = u.cases
        .map(([tag, types]) => `${tag}${types.length > 0 ? " " + types.join(" ") : ""}`)
        .join("\n    | ");
      lines.push("```elm", `type ${u.name}${argsStr}`, `    = ${casesStr}`, "```");
    }

    if (!compact && u.comment) {
      lines.push("", u.comment);
    }
    lines.push("");
  }

  // Aliases
  for (const a of mod.aliases) {
    const argsStr = a.args.length > 0 ? " " + a.args.join(" ") : "";
    lines.push("```elm", `type alias ${a.name}${argsStr} = ${a.type}`, "```");

    if (!compact && a.comment) {
      lines.push("", a.comment);
    }
    lines.push("");
  }

  // Values
  for (const v of mod.values) {
    lines.push("```elm", `${v.name} : ${v.type}`, "```");

    if (!compact && v.comment) {
      lines.push("", v.comment);
    }
    lines.push("");
  }

  // Binops
  for (const b of mod.binops) {
    lines.push(
      "```elm",
      `(${b.name}) : ${b.type}`,
      "```",
      `*${b.associativity} ${b.precedence}*`,
    );

    if (!compact && b.comment) {
      lines.push("", b.comment);
    }
    lines.push("");
  }

  return lines;
}
