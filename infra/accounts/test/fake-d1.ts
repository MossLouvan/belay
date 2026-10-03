// Minimal D1Database over node:sqlite so handlers run against real SQL,
// including the migrations' FK cascades. Covers the subset the service uses:
// prepare/bind/first/all/run and batch.

import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

type Row = Record<string, unknown>;

export function fakeD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);

  const prepare = (sql: string, args: unknown[] = []): D1PreparedStatement => {
    const stmt = db.prepare(sql);
    const params = args as Parameters<typeof stmt.all>;
    const self = {
      bind: (...next: unknown[]) => prepare(sql, next),
      first: async (col?: string) => {
        const row = (stmt.get(...params) as Row | undefined) ?? null;
        return col && row ? row[col] : row;
      },
      all: async () => ({ results: stmt.all(...params) as Row[], success: true, meta: {} }),
      run: async () => {
        const info = stmt.run(...params);
        return { results: [], success: true, meta: { changes: Number(info.changes) } };
      },
      raw: async () => stmt.all(...params).map((r) => Object.values(r as Row)),
    };
    return self as unknown as D1PreparedStatement;
  };

  const batch = async (stmts: D1PreparedStatement[]) => {
    db.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) {
        const { results } = await s.all();
        out.push({ results, success: true, meta: {} });
      }
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return { prepare, batch } as unknown as D1Database;
}
