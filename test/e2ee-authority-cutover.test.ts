import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { databaseBefore } from './support/e2ee-documents';

const migration = readFileSync(
  new URL(
    '../apps/web/migrations/0044_e2ee_project_authority.sql',
    import.meta.url
  ),
  'utf8'
);

it.each([0, 2])(
  'refuses the authority cutover with a legacy group in generation %s without changing its data',
  (generation) => {
    const db = databaseBefore(44);
    db.exec(`INSERT INTO users (id, created_at) VALUES ('legacy_owner', 'before');
    INSERT INTO projects (id, user_id, name, document_json, updated_at, storage_format)
    VALUES ('proj_legacy', 'legacy_owner', '', 'e2ee-v1', 'before', 2);`);
    db.prepare(
      `INSERT INTO e2ee_project_groups
    (project_id, group_id, generation, key_epoch_base, epoch, initial_group_info, group_info, group_info_epoch, updated_at)
    VALUES ('proj_legacy', 'grp_legacy', ?, ?, 7, 'old-root', 'old-state', 7, 'before')`
    ).run(generation, generation * 10);
    const before = db.prepare('SELECT * FROM e2ee_project_groups').all();
    // D1 migrations execute transactionally. A failed cutover never publishes
    // the new schema or discards a group, including one with reset history.
    db.exec('BEGIN');
    expect(() => db.exec(migration)).toThrow(/E2EE_AUTHORITY_CUTOVER_REQUIRED/);
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT * FROM e2ee_project_groups').all()).toEqual(
      before
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('e2ee_project_authority','e2ee_authority_cutover_guard')"
        )
        .all()
    ).toEqual([]);
    expect(db.prepare('SELECT document_json FROM projects').get()).toEqual({
      document_json: 'e2ee-v1'
    });
    db.close();
  }
);

it('allows a fresh cutover and leaves no temporary guard objects', () => {
  const db = databaseBefore(44);
  db.exec(migration);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'e2ee_project_authority'"
      )
      .get()
  ).toBeDefined();
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'e2ee_authority_cutover%'"
      )
      .all()
  ).toEqual([]);
  db.close();
});
