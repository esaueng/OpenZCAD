import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CENSUS_SQL } from '../apps/web/worker/glimpseCensus';
import { census } from '../apps/web/worker/glimpseContract';
function fixture(legacyArtifact = false, upTo = '9999') {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../apps/web/migrations/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && f < upTo)
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
    "INSERT INTO glimpse_account_consent(user_id,expires_at) VALUES('yes','2999-01-01'),('expired','2000-01-01'),('erasing','2999-01-01')"
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
        "INSERT INTO project_document_objects (id, project_id, object_key, checksum_sha256, logical_bytes, stored_bytes, content_encoding, state, created_at) VALUES('o','yes','private/key','sha',100,25,'gzip','committed','2026-01-01')"
      );
      db.exec("UPDATE projects SET document_object_id='o' WHERE id='yes'");
      db.exec(
        "INSERT INTO project_storage_assets (id, project_id, kind, object_key, checksum_sha256, logical_bytes, stored_bytes, content_encoding, created_at) VALUES('a','yes','mesh-payload','private/asset','sha',200,50,'gzip','2026-01-01')"
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
  ACTIVITY_CENSUS_SQL,
  activityCounts,
  censusSnapshot,
  publishCensus
} from '../apps/web/worker/glimpseCensus';
import {
  ACCOUNT_STATISTICS_VERSION,
  ACTIVITY_MIN_COUNT
} from '../apps/web/worker/glimpseContract';
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
    body: JSON.stringify({
      enabled,
      version: ACCOUNT_STATISTICS_VERSION,
      ...extra
    })
  });
}
it('requires explicit current-version account permission and permits withdrawal with collection disabled', async () => {
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

// Account activity (Glimpse review approved 13 Nov 2026). Counts are computed
// in SQL over version-3 grants only; the k-rule runs before anything is sent.
const DAY = 86400000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** Adds a consenting account whose last save was `savedDaysAgo` (null: never). */
function account(
  db: DatabaseSync,
  id: string,
  savedDaysAgo: number | null,
  {
    version = ACCOUNT_STATISTICS_VERSION,
    createdDaysAgo = 400,
    via = 'project'
  }: {
    version?: number;
    createdDaysAgo?: number;
    via?: 'project' | 'revision';
  } = {}
) {
  db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,NULL,?)').run(
    id,
    ago(createdDaysAgo)
  );
  db.prepare(
    'INSERT INTO glimpse_account_consent(user_id,expires_at,version) VALUES(?,?,?)'
  ).run(id, '2999-01-01', version);
  if (savedDaysAgo === null) return;
  if (via === 'project')
    db.prepare(
      "INSERT INTO projects(id,user_id,name,document_json,updated_at,document_bytes) VALUES(?,?,'private name','{}',?,10)"
    ).run(`p-${id}`, id, ago(savedDaysAgo));
  // A revision this account saved on someone else's (shared) project.
  else
    db.prepare(
      "INSERT INTO revisions(id,project_id,reason,document_json,created_at,author_user_id) VALUES(?,'yes','manual','{}',?,?)"
    ).run(`r-${id}`, ago(savedDaysAgo), id);
}
function activityFixture() {
  const db = fixture();
  // 'yes' holds a version-2 grant from before the save-activity text.
  for (let i = 0; i < 6; i++) account(db, `week${i}`, 1);
  for (let i = 0; i < 6; i++) account(db, `month${i}`, 20, { via: 'revision' });
  for (let i = 0; i < 2; i++) account(db, `quarter${i}`, 60);
  for (let i = 0; i < 5; i++) account(db, `idle${i}`, 120);
  account(db, 'never', null); // created 400 days ago, never saved
  account(db, 'newcomer', null, { createdDaysAgo: 3 });
  account(db, 'old-text', 1, { version: 2 });
  return db;
}

describe('account activity counts', () => {
  it('counts saves in SQL over version-3 grants only, with consistent totals', () => {
    const db = activityFixture();
    try {
      const row = db.prepare(ACTIVITY_CENSUS_SQL).get() as Record<
        'accounts' | 'activityAccounts' | 'active7d' | 'active30d' | 'idle90d',
        number
      >;
      expect(row).toMatchObject({
        accounts: 23, // every unexpired, non-erasing grant (v2 and v3)
        activityAccounts: 21, // v3 grants only: not 'yes' or 'old-text'
        active7d: 6,
        active30d: 12,
        idle90d: 6 // five 120-day savers plus the account that never saved
      });
      expect(row.active7d).toBeLessThanOrEqual(row.active30d);
      expect(row.active30d + row.idle90d).toBeLessThanOrEqual(row.accounts);
      // The totals stay the established census over every grant.
      const { activityAccounts, active7d, active30d, idle90d, ...totals } = row;
      void [activityAccounts, active7d, active30d, idle90d];
      expect(totals).toEqual(db.prepare(CENSUS_SQL).get());
      expect(censusSnapshot(row, true)).toMatchObject({
        accounts: 23,
        active7d: 6,
        active30d: 12,
        idle90d: 6
      });
    } finally {
      db.close();
    }
  });

  it('withholds counts below 5 and counts leaving fewer than 5 outside them', () => {
    const counts = (raw: Record<string, number>, accounts = 100) =>
      activityCounts({ activityAccounts: 100, ...raw }, accounts);
    expect(ACTIVITY_MIN_COUNT).toBe(5);
    expect(counts({ active7d: 4, active30d: 5, idle90d: 0 })).toEqual({
      active7d: null,
      active30d: 5,
      idle90d: null
    });
    // Complement: 100 - 96 = 4 accounts outside is withheld, 95 is not.
    expect(counts({ active7d: 95, active30d: 96, idle90d: 0 })).toEqual({
      active7d: 95,
      active30d: null,
      idle90d: null
    });
    // Judged against the activity population too: 20 v3 grants of 30.
    expect(
      activityCounts(
        { activityAccounts: 20, active7d: 16, active30d: 16, idle90d: 4 },
        30
      )
    ).toEqual({ active7d: null, active30d: null, idle90d: null });
    expect(
      activityCounts(
        { activityAccounts: 20, active7d: 15, active30d: 15, idle90d: 5 },
        30
      )
    ).toEqual({ active7d: 15, active30d: 15, idle90d: 5 });
    // Under 10 consenting accounts every count is withheld.
    expect(
      activityCounts(
        { activityAccounts: 9, active7d: 5, active30d: 5, idle90d: 0 },
        9
      )
    ).toEqual({ active7d: null, active30d: null, idle90d: null });
  });

  it('withholds everything rather than send counts that break an invariant', () => {
    const all = { active7d: null, active30d: null, idle90d: null };
    for (const raw of [
      { activityAccounts: 50, active7d: 30, active30d: 20, idle90d: 5 },
      { activityAccounts: 50, active7d: 10, active30d: 30, idle90d: 25 },
      { activityAccounts: 50, active7d: 10, active30d: 60, idle90d: 5 },
      { activityAccounts: 60, active7d: 10, active30d: 20, idle90d: 5 },
      { activityAccounts: 50, active7d: -1, active30d: 20, idle90d: 5 },
      { activityAccounts: 50, active7d: 1.5, active30d: 20, idle90d: 5 },
      { active7d: 10, active30d: 20, idle90d: 5 }
    ])
      expect(activityCounts(raw, 50), JSON.stringify(raw)).toEqual(all);
  });

  it('sends the three fields together, never activityAccounts or raw small counts', async () => {
    const db = activityFixture();
    const snapshot = vi.fn().mockResolvedValue({ accepted: true });
    try {
      expect(
        await publishCensus({
          DB: d1(db),
          GLIMPSE_USAGE_ENABLED: 'true',
          GLIMPSE: { snapshot }
        })
      ).toBe(true);
      const sent = snapshot.mock.calls[0]![0] as Record<string, unknown>;
      expect(Object.keys(sent).sort()).toEqual(
        [
          'generation',
          'accounts',
          'projects',
          'revisions',
          'storedBytes',
          'logicalBytes',
          'unknownArtifacts',
          'lt1mib',
          'mib1to10',
          'mib10to100',
          'gte100mib',
          'active7d',
          'active30d',
          'idle90d'
        ].sort()
      );
      expect(sent).toMatchObject({
        accounts: 23,
        active7d: 6,
        active30d: 12,
        idle90d: 6
      });
      expect(census(sent, 'openzcad')).toEqual(sent);
      // Fewer than 10 version-3 accounts: all withheld, still sent together.
      db.exec(
        "DELETE FROM glimpse_account_consent WHERE user_id LIKE 'week%' OR user_id LIKE 'month%'"
      );
      await publishCensus({
        DB: d1(db),
        GLIMPSE_USAGE_ENABLED: 'true',
        GLIMPSE: { snapshot }
      });
      expect(snapshot.mock.calls[1]![0]).toMatchObject({
        accounts: 11,
        active7d: null,
        active30d: null,
        idle90d: null
      });
    } finally {
      db.close();
    }
  });

  it('handles the { accepted } reply and an older Glimpse without looping', async () => {
    const db = activityFixture();
    const env = (snapshot: ReturnType<typeof vi.fn>) => ({
      DB: d1(db),
      GLIMPSE_USAGE_ENABLED: 'true',
      GLIMPSE: { snapshot }
    });
    try {
      // A newer generation is already stored: not an error, not published.
      const stale = vi.fn().mockResolvedValue({ accepted: false });
      expect(await publishCensus(env(stale))).toBe(false);
      expect(stale).toHaveBeenCalledOnce();
      // Glimpse before esaueng/glimpse#32 resolves undefined on success...
      const legacy = vi.fn().mockResolvedValue(undefined);
      expect(await publishCensus(env(legacy))).toBe(true);
      // ...and rejects activity fields as an invalid census: one retry
      // without them keeps the agreed totals flowing.
      const old = vi.fn(async (value: Record<string, unknown>) => {
        if ('active7d' in value) throw new Error('Invalid census');
      });
      expect(await publishCensus(env(old))).toBe(true);
      expect(old).toHaveBeenCalledTimes(2);
      expect(old.mock.calls[1]![0]).not.toHaveProperty('active7d');
      expect(old.mock.calls[1]![0]).not.toHaveProperty('idle90d');
      expect(old.mock.calls[1]![0].generation).toBe(
        old.mock.calls[0]![0].generation
      );
      // Any other failure, or a second rejection, waits for the next hour.
      const down = vi.fn().mockRejectedValue(new Error('unavailable'));
      expect(await publishCensus(env(down))).toBe(false);
      expect(down).toHaveBeenCalledOnce();
      const strict = vi.fn().mockRejectedValue(new Error('Invalid census'));
      expect(await publishCensus(env(strict))).toBe(false);
      expect(strict).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('works before migration 0047: totals only, grants stored without a version', async () => {
    const db = fixture(false, '0047');
    const snapshot = vi.fn().mockResolvedValue({ accepted: true });
    const env = {
      DB: d1(db),
      GLIMPSE_USAGE_ENABLED: 'true',
      GLIMPSE: { snapshot }
    };
    try {
      expect((await accountConsent(choice(true), env, 'no')).status).toBe(200);
      const sent = snapshot.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent).toMatchObject({ accounts: 2 });
      expect(sent).not.toHaveProperty('active7d');
      const read = await accountConsent(
        new Request('https://app.test/api/glimpse/account-consent'),
        env,
        'no'
      );
      expect(await read.json()).toMatchObject({ enabled: true, version: 2 });
    } finally {
      db.close();
    }
  });
});

describe('account-statistics permission version', () => {
  it('grants only the current text, accepts withdrawal from the old one, and reports the version', async () => {
    const db = activityFixture();
    const snapshot = vi.fn().mockResolvedValue({ accepted: true });
    const env = {
      DB: d1(db),
      GLIMPSE_USAGE_ENABLED: 'true',
      GLIMPSE: { snapshot }
    };
    const read = async (user: string) =>
      (await accountConsent(
        new Request('https://app.test/api/glimpse/account-consent'),
        env,
        user
      ).then((r) => r.json())) as Record<string, unknown>;
    try {
      // A page still showing the version 2 text cannot grant the new scope.
      expect(
        (await accountConsent(choice(true, { version: 2 }), env, 'no')).status
      ).toBe(400);
      expect(
        (await accountConsent(choice(true, { version: 4 }), env, 'no')).status
      ).toBe(400);
      // An existing version 2 grant keeps covering totals only.
      expect(await read('yes')).toMatchObject({
        enabled: true,
        version: 2,
        currentVersion: ACCOUNT_STATISTICS_VERSION
      });
      // Renewing records the current version and enrols it in activity.
      const before = (
        db.prepare(ACTIVITY_CENSUS_SQL).get() as {
          activityAccounts: number;
        }
      ).activityAccounts;
      expect((await accountConsent(choice(true), env, 'yes')).status).toBe(200);
      expect(await read('yes')).toMatchObject({
        enabled: true,
        version: ACCOUNT_STATISTICS_VERSION
      });
      expect(
        (db.prepare(ACTIVITY_CENSUS_SQL).get() as { activityAccounts: number })
          .activityAccounts
      ).toBe(before + 1);
      // Withdrawal works from either text.
      expect(
        (await accountConsent(choice(false, { version: 2 }), env, 'yes')).status
      ).toBe(200);
      expect(await read('yes')).toMatchObject({
        enabled: false,
        version: null
      });
    } finally {
      db.close();
    }
  });
});
