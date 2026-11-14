import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const MIGRATIONS = new URL('../../apps/web/migrations/', import.meta.url);

/**
 * D1's documented ceiling: "Maximum bound parameters per query: 100"
 * (https://developers.cloudflare.com/d1/platform/limits/). Local SQLite
 * accepts 32,766, so a statement that only breaks at D1's limit passes every
 * plain SQLite test and fails in production.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** An in-memory database with every tracked D1 migration applied, in order. */
export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  return db;
}

export interface SqliteD1Options {
  /** Sees every statement as it executes, batched or not. */
  onStatement?(sql: string, bindings: readonly SQLInputValue[]): void;
}

/**
 * A D1 binding backed by real SQLite: the production statements run as
 * written — joins, `json_extract`, triggers and `changes()` included — instead
 * of being matched as query text. `meta.changes` counts what triggers wrote,
 * as D1's does.
 *
 * It holds the line D1 holds and SQLite does not: more than
 * {@link D1_MAX_BOUND_PARAMETERS} bound parameters fails the statement, and
 * `undefined` cannot be bound. Booleans bind as 1/0, as D1 stores them. A
 * batch runs in one transaction and rolls back whole on any failure.
 */
export function sqliteD1(
  db: DatabaseSync,
  options: SqliteD1Options = {}
): D1Database {
  const execute = <T>(
    sql: string,
    bindings: readonly SQLInputValue[],
    run: (statement: ReturnType<DatabaseSync['prepare']>) => T
  ): T => {
    options.onStatement?.(sql, bindings);
    if (bindings.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(
        `D1_ERROR: too many SQL variables (${bindings.length} bound, limit ${D1_MAX_BOUND_PARAMETERS})`
      );
    }
    return run(db.prepare(sql));
  };
  const totalChanges = () =>
    Number(
      (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    );
  const toBinding = (value: unknown): SQLInputValue => {
    if (value === undefined) {
      throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported");
    }
    return typeof value === 'boolean'
      ? Number(value)
      : (value as SQLInputValue);
  };
  const statement = (sql: string, bindings: readonly SQLInputValue[] = []) => {
    const all = () => ({
      results: execute(sql, bindings, (prepared) =>
        prepared.all(...bindings)
      ) as Record<string, unknown>[],
      success: true,
      meta: { changes: 0 }
    });
    const run = () => {
      // D1 runs a row-returning statement through run() too and hands the
      // rows back in `results`.
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
        return all();
      }
      // D1 reports `meta.changes` as SQLite's total_changes() moved by the
      // statement, so rows its triggers wrote count too (one UPDATE that
      // fires a trigger updating one more row reports 2), unlike
      // sqlite3_changes(). Measured the same way here, so a Worker that
      // tests a write by its change count sees what D1 tells it.
      // Measured around this statement alone: what `onStatement` writes
      // first stands for another writer, which D1 does not count here.
      const returning = /\bRETURNING\b/i.test(sql);
      return execute(sql, bindings, (prepared) => {
        const before = totalChanges();
        const results = returning
          ? (prepared.all(...bindings) as Record<string, unknown>[])
          : (prepared.run(...bindings), []);
        return {
          results,
          success: true,
          meta: { changes: totalChanges() - before }
        };
      });
    };
    return {
      sql,
      bindings,
      bind: (...next: unknown[]) => statement(sql, next.map(toBinding)),
      first: async (column?: string) => {
        const row = execute(sql, bindings, (prepared) =>
          prepared.get(...bindings)
        ) as Record<string, unknown> | undefined;
        if (!row) return null;
        return column === undefined ? row : (row[column] ?? null);
      },
      all: async () => all(),
      run: async () => run(),
      runInBatch: run
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((item) => item.runInBatch());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } as unknown as D1Database;
}
