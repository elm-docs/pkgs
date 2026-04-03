import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../lib/sqlite.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY,
    org TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT,
    UNIQUE(org, name)
);

CREATE TABLE IF NOT EXISTS package_versions (
    id INTEGER PRIMARY KEY,
    package_id INTEGER NOT NULL REFERENCES packages(id),
    version TEXT NOT NULL,
    version_sort INTEGER NOT NULL DEFAULT 0,
    UNIQUE(package_id, version)
);

CREATE TABLE IF NOT EXISTS modules (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES package_versions(id),
    name TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    UNIQUE(version_id, name)
);

CREATE TABLE IF NOT EXISTS "values" (
    id INTEGER PRIMARY KEY,
    module_id INTEGER NOT NULL REFERENCES modules(id),
    name TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    UNIQUE(module_id, name)
);
`;

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "elm-docs-test-"));
});

describe("Database wrapper", () => {
  it("creates schema with exec()", async () => {
    const dbPath = join(tmpDir, "test-schema.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();

    const names = tables.map((t) => t.name);
    assert.ok(names.includes("packages"));
    assert.ok(names.includes("package_versions"));
    assert.ok(names.includes("modules"));
    assert.ok(names.includes("values"));

    db.close();
  });

  it("insert + query round-trip with positional params", async () => {
    const dbPath = join(tmpDir, "test-roundtrip.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    db.prepare(
      "INSERT INTO packages (org, name, summary) VALUES (?, ?, ?)",
    ).run("elm", "core", "Core libraries");

    const row = db
      .prepare("SELECT * FROM packages WHERE org = ? AND name = ?")
      .get("elm", "core");

    assert.equal(row.org, "elm");
    assert.equal(row.name, "core");
    assert.equal(row.summary, "Core libraries");

    db.close();
  });

  it("named @param binding", async () => {
    const dbPath = join(tmpDir, "test-named.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    db.prepare(
      "INSERT INTO packages (org, name) VALUES (@org, @name)",
    ).run({ org: "elm", name: "json" });

    const row = db
      .prepare("SELECT * FROM packages WHERE org = @org")
      .get({ org: "elm" });

    assert.equal(row.name, "json");

    db.close();
  });

  it("INSERT ... ON CONFLICT ... RETURNING id", async () => {
    const dbPath = join(tmpDir, "test-returning.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    const stmt = db.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?) ON CONFLICT(org, name) DO UPDATE SET org = org RETURNING id",
    );

    const row1 = stmt.get("elm", "core");
    assert.ok(typeof row1.id === "number");

    const row2 = stmt.get("elm", "core");
    assert.equal(row1.id, row2.id);

    db.close();
  });

  it("transaction commit persists data", async () => {
    const dbPath = join(tmpDir, "test-tx-commit.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    const insert = db.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?)",
    );
    const tx = db.transaction(() => {
      insert.run("elm", "core");
      insert.run("elm", "json");
    });
    tx();

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM packages")
      .get();
    assert.equal(count.c, 2);

    db.close();
  });

  it("transaction rollback on error", async () => {
    const dbPath = join(tmpDir, "test-tx-rollback.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    const insert = db.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?)",
    );
    const tx = db.transaction(() => {
      insert.run("elm", "core");
      throw new Error("deliberate error");
    });

    assert.throws(() => tx(), { message: "deliberate error" });

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM packages")
      .get();
    assert.equal(count.c, 0);

    db.close();
  });

  it("readonly mode does not modify file", async () => {
    const dbPath = join(tmpDir, "test-readonly.db");

    // Create a db with data
    const db1 = await Database.open(dbPath);
    db1.exec(SCHEMA);
    db1.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?)",
    ).run("elm", "core");
    db1.close();

    // Open readonly and add data (in-memory only)
    const db2 = await Database.open(dbPath, { readonly: true });
    db2.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?)",
    ).run("elm", "json");
    db2.close(); // should NOT write back

    // Re-open and verify second insert was not persisted
    const db3 = await Database.open(dbPath, { readonly: true });
    const count = db3
      .prepare("SELECT COUNT(*) AS c FROM packages")
      .get();
    assert.equal(count.c, 1);
    db3.close();
  });

  it("exec() with multiple DDL statements", async () => {
    const dbPath = join(tmpDir, "test-multi-ddl.db");
    const db = await Database.open(dbPath);

    db.exec(`
      CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT);
      CREATE TABLE t2 (id INTEGER PRIMARY KEY, ref INTEGER REFERENCES t1(id));
      CREATE INDEX idx_t2_ref ON t2(ref);
    `);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();
    const names = tables.map((t) => t.name);

    assert.ok(names.includes("t1"));
    assert.ok(names.includes("t2"));

    db.close();
  });

  it("fileMustExist throws for missing file", async () => {
    await assert.rejects(
      () =>
        Database.open(join(tmpDir, "nonexistent.db"), {
          fileMustExist: true,
        }),
      /Database file not found/,
    );
  });

  it("data persists across close + reopen", async () => {
    const dbPath = join(tmpDir, "test-persist.db");

    const db1 = await Database.open(dbPath);
    db1.exec(SCHEMA);
    db1.prepare(
      "INSERT INTO packages (org, name) VALUES (?, ?)",
    ).run("elm", "core");
    db1.close();

    const db2 = await Database.open(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    const row = db2
      .prepare("SELECT org, name FROM packages")
      .get();
    assert.equal(row.org, "elm");
    assert.equal(row.name, "core");
    db2.close();
  });

  it("stmt.all() returns empty array for no matches", async () => {
    const dbPath = join(tmpDir, "test-empty.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    const rows = db
      .prepare("SELECT * FROM packages WHERE org = ?")
      .all("nonexistent");
    assert.deepEqual(rows, []);

    db.close();
  });

  it("stmt.get() returns undefined for no match", async () => {
    const dbPath = join(tmpDir, "test-undef.db");
    const db = await Database.open(dbPath);
    db.exec(SCHEMA);

    const row = db
      .prepare("SELECT * FROM packages WHERE org = ?")
      .get("nonexistent");
    assert.equal(row, undefined);

    db.close();
  });
});
