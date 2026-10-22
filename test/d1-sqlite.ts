import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * A D1 binding over in-memory SQLite with every real migration applied, so
 * Worker routes run against the production schema, its CHECK constraints
 * and foreign keys, in Vitest and in Playwright route handlers alike. Only
 * the transport is adapted: `batch` is one transaction, as on D1, and `run`
 * reports `meta.changes`.
 */
export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../apps/web/migrations/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return db;
}

class Statement {
  values: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string
  ) {}

  bind(...values: unknown[]) {
    this.values = values.map((value) =>
      value === undefined ? null : (value as SQLInputValue)
    );
    return this;
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) }
    };
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.db.prepare(this.sql).all(...this.values) as T[],
      meta: { changes: 0 }
    };
  }
}

export function d1Database(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(
            /^\s*(SELECT|WITH)\b/i.test(statement.sql)
              ? await statement.all()
              : await statement.run()
          );
        }
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
