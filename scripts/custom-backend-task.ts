import { resolve } from "node:path";
import Database from "better-sqlite3";

interface QueryTypeIndexInput {
  dbPath: string;
  minArgs: number;
  maxArgs: number;
}

interface Context {
  cwd: string;
}

interface TypeIndexRow {
  module_name: string;
  name: string;
  kind: string;
  type_raw: string;
  type_ast: string;
  fingerprint: string;
  org: string;
  pkg_name: string;
}

export async function queryTypeIndex(
  input: QueryTypeIndexInput,
  context: Context,
): Promise<TypeIndexRow[]> {
  const dbPath = resolve(context.cwd, input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = WAL");

  try {
    const rows = db
      .prepare(
        `SELECT ti.module_name, ti.name, ti.kind, ti.type_raw, ti.type_ast, ti.fingerprint,
                p.org, p.name AS pkg_name
         FROM type_index ti
         JOIN packages p ON ti.package_id = p.id
         WHERE ti.arg_count BETWEEN ? AND ?`,
      )
      .all(input.minArgs, input.maxArgs) as TypeIndexRow[];

    return rows;
  } finally {
    db.close();
  }
}
