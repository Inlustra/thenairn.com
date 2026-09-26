// Bun can't load the native better-sqlite3 addon; Mem0 imports it for its
// history and SQLite vector store. bun:sqlite has the same shape, so hand it
// that instead. (Aliased in package.json.)
import { Database } from "bun:sqlite";
export default class BetterSqlite3Shim extends Database {
  constructor(path, opts) {
    super(path ?? ":memory:", { create: true, ...(opts?.readonly ? { readonly: true } : {}) });
  }
  pragma(p) {
    return this.query(`PRAGMA ${p}`).all();
  }
}
