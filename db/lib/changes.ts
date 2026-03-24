import { globSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

export interface FileChange {
  absolute: string;
  relative: string;
  mtimeMs: number;
  size: number;
}

export function findChangedFiles(
  db: Database.Database,
  contentDir: string,
  globPattern: string,
): FileChange[] {
  const files = globSync(globPattern, { cwd: contentDir }) as string[];
  const getMeta = db.prepare(
    "SELECT mtime_ms, size_bytes FROM _build_meta WHERE file_path = ?",
  );

  const changed: FileChange[] = [];
  for (const rel of files) {
    const abs = join(contentDir, rel);
    const st = statSync(abs);
    const row = getMeta.get(rel) as
      | { mtime_ms: number; size_bytes: number }
      | undefined;
    if (!row || row.mtime_ms !== Math.floor(st.mtimeMs) || row.size_bytes !== st.size) {
      changed.push({
        absolute: abs,
        relative: rel,
        mtimeMs: Math.floor(st.mtimeMs),
        size: st.size,
      });
    }
  }
  return changed;
}

export function recordFile(
  db: Database.Database,
  relPath: string,
  mtimeMs: number,
  size: number,
): void {
  db.prepare(
    `INSERT INTO _build_meta (file_path, mtime_ms, size_bytes)
     VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes`,
  ).run(relPath, mtimeMs, size);
}
