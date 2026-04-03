/**
 * Compatibility wrapper around sql.js (WASM) that exposes a
 * better-sqlite3–like synchronous API.
 *
 * Key differences from better-sqlite3:
 *   - Database.open(path, opts?) is async (WASM init)
 *   - Named parameter keys in bound objects are unprefixed (same as better-sqlite3)
 *     and are mapped to @-prefixed parameters in the SQL
 *   - close() writes the database back to disk for writable databases
 */

import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let sqlPromise = null;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const sqlJsMain = require.resolve("sql.js");
      const wasmBinary = readFileSync(join(dirname(sqlJsMain), "sql-wasm.wasm"));
      return initSqlJs({ wasmBinary });
    })();
  }
  return sqlPromise;
}

class Statement {
  constructor(sqlJsDb, sql) {
    this._db = sqlJsDb;
    this._stmt = sqlJsDb.prepare(sql);
  }

  _bind(params) {
    if (params.length === 0) {
      this._stmt.reset();
      return;
    }
    if (
      params.length === 1 &&
      typeof params[0] === "object" &&
      params[0] !== null &&
      !Array.isArray(params[0])
    ) {
      const obj = {};
      for (const [key, val] of Object.entries(params[0])) {
        obj[`@${key}`] = val;
      }
      this._stmt.bind(obj);
    } else {
      this._stmt.bind(params);
    }
  }

  all(...params) {
    this._bind(params);
    const results = [];
    while (this._stmt.step()) {
      results.push(this._stmt.getAsObject());
    }
    this._stmt.reset();
    return results;
  }

  get(...params) {
    this._bind(params);
    let result = undefined;
    if (this._stmt.step()) {
      result = this._stmt.getAsObject();
    }
    this._stmt.reset();
    return result;
  }

  run(...params) {
    this._bind(params);
    this._stmt.step();
    this._stmt.reset();
    return { changes: this._db.getRowsModified() };
  }
}

export class Database {
  /**
   * Open (or create) a SQLite database backed by a file.
   *
   * @param {string} path   — filesystem path
   * @param {object} [opts]
   * @param {boolean} [opts.readonly]       — skip write-back on close
   * @param {boolean} [opts.fileMustExist]  — throw if file is missing
   */
  static async open(path, opts = {}) {
    const SQL = await getSql();
    const readonly = opts.readonly || false;
    const fileMustExist = opts.fileMustExist || false;

    if (fileMustExist && !existsSync(path)) {
      throw new Error(`Database file not found: ${path}`);
    }

    let db;
    if (existsSync(path)) {
      const data = readFileSync(path);
      db = new SQL.Database(data);
    } else {
      db = new SQL.Database();
    }

    return new Database(db, path, readonly);
  }

  /** @private — use Database.open() instead */
  constructor(db, path, readonly) {
    this._db = db;
    this._path = path;
    this._readonly = readonly;
  }

  pragma(str) {
    this._db.exec(`PRAGMA ${str}`);
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  prepare(sql) {
    return new Statement(this._db, sql);
  }

  transaction(fn) {
    const self = this;
    return function (...args) {
      self._db.run("BEGIN");
      try {
        const result = fn(...args);
        self._db.run("COMMIT");
        return result;
      } catch (e) {
        self._db.run("ROLLBACK");
        throw e;
      }
    };
  }

  close() {
    if (!this._readonly && this._path) {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      const tmpPath = this._path + ".tmp";
      writeFileSync(tmpPath, buffer);
      renameSync(tmpPath, this._path);
    }
    this._db.close();
  }
}
