import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * Migrations reach D1 as one SQL script and are cut into statements before
 * execution — by Wrangler for `--local`, and by the D1 service itself for
 * `--remote`, which is what `pnpm deploy:beta` runs. Neither splitter parses
 * SQL; both scan for delimiters. A statement that survives `sqlite3` as a
 * whole file can still be cut in the wrong place and reach SQLite as a
 * fragment.
 *
 * That is not hypothetical: migration 0017 shipped with `SELECT CASE … END;`
 * inside a trigger body. The service's splitter closes a compound statement
 * at the first `END;` it sees, so the trigger arrived truncated and the beta
 * deploy died on `incomplete input: SQLITE_ERROR [code: 7500]` — after the
 * suite below passed, because the suite feeds each migration to
 * `exec()` whole and `exec()` never splits.
 *
 * So this file re-splits every migration the way the tooling does and runs
 * the pieces one at a time. Both splitters are modelled because they fail on
 * different constructs, and a migration has to survive both.
 */

const MIGRATIONS = new URL('../apps/web/migrations/', import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/**
 * Wrangler's `splitSqlQuery` (src/d1/splitter.ts), reduced to the delimiter
 * rules. It tracks `BEGIN` and `CASE` on one stack and closes either with
 * `/\sEND[;\s]$/` — so a `CASE` expression closed by `END,` or `END)` is
 * never popped and every following `;` is swallowed.
 */
function splitLikeWrangler(sql: string): string[] {
  const statements: string[] = [];
  let str = '';
  const stack: ((value: string) => boolean)[] = [];
  const iterator = sql[Symbol.iterator]();
  const consumeWhile = (predicate: (value: string) => boolean): string => {
    let next = iterator.next();
    let taken = '';
    while (!next.done) {
      taken += next.value;
      if (!predicate(taken)) {
        break;
      }
      next = iterator.next();
    }
    return taken;
  };
  const consumeUntil = (marker: string) =>
    consumeWhile((value) => !value.endsWith(marker));
  let next = iterator.next();
  while (!next.done) {
    const char = next.value;
    if (stack[0]?.(str + char)) {
      stack.shift();
    }
    if (char === `'` || char === '"' || char === '`') {
      str += char + consumeUntil(char);
    } else if (char === '-') {
      next = iterator.next();
      if (!next.done && next.value === '-') {
        consumeUntil('\n');
        str += '\n';
      } else {
        str += char;
        continue;
      }
    } else if (char === ';') {
      if (stack.length === 0) {
        statements.push(str);
        str = '';
      } else {
        str += char;
      }
    } else {
      str += char;
    }
    if (/\s(BEGIN|CASE)\s$/i.test(str)) {
      stack.unshift((value: string) => /\sEND[;\s]$/.test(value));
    }
    next = iterator.next();
  }
  statements.push(str);
  return statements.map((one) => one.trim()).filter((one) => one.length > 0);
}

/**
 * The pessimistic reading, and the one the D1 service demonstrably uses: a
 * compound statement opens at `BEGIN` and closes at the next `END;`, with no
 * notion of nesting. Anything safe here is safe under a smarter splitter,
 * except for the `END,` case above — hence both.
 */
function splitLikeD1Service(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
  const statements: string[] = [];
  let str = '';
  let inCompound = false;
  for (const char of withoutComments) {
    str += char;
    if (!inCompound && /\sBEGIN\s$/i.test(str)) {
      inCompound = true;
      continue;
    }
    if (char === ';') {
      if (inCompound && !/\sEND;$/.test(str)) {
        continue;
      }
      inCompound = false;
      statements.push(str);
      str = '';
    }
  }
  statements.push(str);
  return statements.map((one) => one.trim()).filter((one) => one.length > 0);
}

const SPLITTERS = [
  { name: 'wrangler --local', split: splitLikeWrangler },
  { name: 'D1 service --remote', split: splitLikeD1Service }
] as const;

describe('D1 migrations survive statement splitting', () => {
  for (const { name, split } of SPLITTERS) {
    it(`applies every statement individually under ${name}`, () => {
      const db = new DatabaseSync(':memory:');
      try {
        for (const file of migrationFiles()) {
          const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
          for (const statement of split(sql)) {
            // A mis-split trigger or CASE arrives here as a fragment and
            // throws `incomplete input` — the exact deploy failure.
            expect(
              () => db.exec(statement),
              `${file}: ${statement.slice(0, 80)}`
            ).not.toThrow();
          }
        }
      } finally {
        db.close();
      }
    });
  }

  it('closes every END with a delimiter Wrangler recognises', () => {
    // Wrangler pops a compound statement on `/\sEND[;\s]$/`, so a `CASE`
    // expression written `END,` or `END)` never closes and every following
    // `;` is swallowed into one oversized statement. The behavioural test
    // above cannot see that — `exec()` runs a merged script happily — so the
    // shape is pinned directly.
    for (const file of migrationFiles()) {
      const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
      const offenders = sql.match(/\bEND[^;\s]/g) ?? [];
      expect(offenders, `${file}: END must be followed by ';' or whitespace`)
        .toEqual([]);
    }
  });
});
