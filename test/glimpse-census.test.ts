import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CENSUS_SQL } from '../apps/web/worker/glimpseCensus';
import { census } from '../apps/web/worker/glimpseContract';
function fixture(legacyArtifact = false) {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../apps/web/migrations/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (legacyArtifact && file.startsWith('0017')) {
      db.exec(
        "INSERT INTO users(id,email,created_at) VALUES('yes',NULL,'2026-01-01')"
      );
      db.exec(
        "INSERT INTO projects(id,user_id,name,document_json,updated_at,document_bytes) VALUES('yes','yes','private name','{}','2026-01-01',100)"
      );
      db.exec(
        "INSERT INTO artifacts(id,project_id,kind,name,object_key,content_type,metadata_json,created_at) VALUES('legacy','yes','export','private','private/artifact','application/octet-stream','{}','2026-01-01')"
      );
    }
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  for (const id of ['yes', 'no', 'expired', 'erasing']) {
    db.prepare(
      "INSERT OR IGNORE INTO users(id,email,created_at) VALUES(?,NULL,'2026-01-01')"
    ).run(id);
    db.prepare(
      "INSERT OR IGNORE INTO projects(id,user_id,name,document_json,updated_at,document_bytes) VALUES(?,?,'private name','{}','2026-01-01',100)"
    ).run(id, id);
  }
  db.exec(
    "INSERT INTO glimpse_account_consent VALUES('yes','2999-01-01'),('expired','2000-01-01'),('erasing','2999-01-01')"
  );
  db.exec("INSERT INTO account_erasure_requests VALUES('erasing','all',1,1)");
  db.exec('UPDATE glimpse_census_clock SET generation=1');
  return db;
}
describe('opt-in cloud census SQL against the actual migrations', () => {
  it('includes only consenting, unexpired, non-erasing accounts and only their own projects', () => {
    const db = fixture();
    try {
      const row = db.prepare(CENSUS_SQL).get();
      expect(census(row, 'openzcad')).toEqual({
        generation: 1,
        accounts: 1,
        projects: 1,
        revisions: 0,
        storedBytes: 100,
        logicalBytes: 100,
        unknownArtifacts: 0,
        lt1mib: 1,
        mib1to10: 0,
        mib10to100: 0,
        gte100mib: 0
      });
      db.exec("DELETE FROM glimpse_account_consent WHERE user_id='yes'");
      expect(census(db.prepare(CENSUS_SQL).get(), 'openzcad')).toMatchObject({
        accounts: 0,
        projects: 0,
        storedBytes: 0
      });
    } finally {
      db.close();
    }
  });
  it('does not double count D1 projections with R2 pointers; includes retained objects and assets', () => {
    const db = fixture(true);
    try {
      db.exec(
        "INSERT INTO project_document_objects VALUES('o','yes','private/key','sha',100,25,'gzip','committed','2026-01-01')"
      );
      db.exec("UPDATE projects SET document_object_id='o' WHERE id='yes'");
      db.exec(
        "INSERT INTO project_storage_assets VALUES('a','yes','mesh-payload','private/asset','sha',200,50,'gzip','2026-01-01')"
      );
      expect(census(db.prepare(CENSUS_SQL).get(), 'openzcad')).toMatchObject({
        storedBytes: 75,
        logicalBytes: 300,
        unknownArtifacts: 1
      });
      db.exec(
        "DELETE FROM projects WHERE id='yes'; DELETE FROM users WHERE id='yes'"
      );
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM glimpse_account_consent WHERE user_id='yes'"
          )
          .get()
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});

// Exercise consent expiry/revocation and publication against SQLite, adapting
// only the D1 transport methods rather than substituting query results.
import {
  accountConsent,
  publishCensus
} from '../apps/web/worker/glimpseCensus';
import { vi } from 'vitest';
function d1(db: DatabaseSync): D1Database {
  class Statement implements D1PreparedStatement {
    values: never[] = [];
    constructor(readonly sql: string) {}
    bind(...values: never[]) {
      this.values = values;
      return this;
    }
    async run() {
      db.prepare(this.sql).run(...this.values);
      return { success: true };
    }
    async first<T>() {
      return (db.prepare(this.sql).get(...this.values) ?? null) as T | null;
    }
    async all<T>() {
      return { results: db.prepare(this.sql).all(...this.values) as T[] };
    }
  }
  return {
    prepare: (sql) => new Statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const stmt of statements) {
          const s = stmt as Statement;
          results.push(
            s.sql.startsWith('UPDATE')
              ? await s.run()
              : { ...(await s.all()), success: true }
          );
        }
        db.exec('COMMIT');
        return results;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  };
}
function choice(enabled: boolean, extra = {}) {
  return new Request('https://app.test/api/glimpse/account-consent', {
    method: 'POST',
    headers: { Origin: 'https://app.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, version: 2, ...extra })
  });
}
it('requires explicit v2 account permission and permits withdrawal with collection disabled', async () => {
  const db = fixture();
  const snapshot = vi.fn().mockResolvedValue(undefined);
  const env = {
    DB: d1(db),
    GLIMPSE_USAGE_ENABLED: 'true',
    GLIMPSE: { snapshot }
  };
  try {
    expect(
      (await accountConsent(choice(true, { email: 'private' }), env, 'no'))
        .status
    ).toBe(400);
    expect((await accountConsent(choice(true), env, 'no')).status).toBe(200);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(snapshot.mock.calls[0]?.[0]).toMatchObject({
      accounts: 2,
      projects: 2
    });
    const active = await accountConsent(
      new Request('https://app.test/api/glimpse/account-consent'),
      env,
      'no'
    );
    expect(await active.json()).toMatchObject({ enabled: true });
    expect(
      (
        await accountConsent(
          choice(false),
          { ...env, GLIMPSE_USAGE_ENABLED: 'false' },
          'no'
        )
      ).status
    ).toBe(200);
    expect(
      db
        .prepare("SELECT * FROM glimpse_account_consent WHERE user_id='no'")
        .get()
    ).toBeUndefined();
    expect(
      await publishCensus({ ...env, GLIMPSE_USAGE_ENABLED: 'false' })
    ).toBe(false);
  } finally {
    db.close();
  }
});
it('tolerates missing service bindings without exporting or failing the product', async () => {
  const db = fixture();
  try {
    expect(
      await publishCensus({ DB: d1(db), GLIMPSE_USAGE_ENABLED: 'true' })
    ).toBe(false);
  } finally {
    db.close();
  }
});
