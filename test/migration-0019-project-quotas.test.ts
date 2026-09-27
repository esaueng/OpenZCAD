import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  MAX_ACCOUNT_PROJECTS,
  MAX_ACCOUNT_PROJECT_STORAGE_BYTES
} from '@openzcad/shared';

const MIGRATIONS = new URL('../apps/web/migrations/', import.meta.url);

function migrate(db: DatabaseSync, through = '0019'): void {
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql') && name.slice(0, 4) <= through)
    .sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
}

function project(
  db: DatabaseSync,
  id: string,
  owner = 'owner',
  status = 'active'
): void {
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at, status)
     VALUES (?, ?, ?, '{}', '2026-01-01T00:00:00.000Z', ?)`
  ).run(id, owner, id, status);
}

function object(
  db: DatabaseSync,
  id: string,
  projectId: string,
  bytes: number
): void {
  db.prepare(
    `INSERT INTO project_document_objects
       (id, project_id, object_key, checksum_sha256, logical_bytes,
        stored_bytes, content_encoding, state, created_at)
     VALUES (?, ?, ?, 'sha', ?, ?, 'gzip', 'committed', '2026-01-01T00:00:00.000Z')`
  ).run(id, projectId, id, bytes, bytes);
}

function asset(
  db: DatabaseSync,
  id: string,
  projectId: string,
  bytes: number
): void {
  db.prepare(
    `INSERT OR IGNORE INTO project_storage_assets
       (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
        stored_bytes, content_encoding, created_at)
     VALUES (?, ?, 'step-source', ?, ?, ?, ?, 'gzip', '2026-01-01T00:00:00.000Z')`
  ).run(id, projectId, id, id, bytes, bytes);
}

describe('project account quota migration', () => {
  it('counts deleted projects and frees a slot only after hard deletion', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db);
      for (let index = 0; index < MAX_ACCOUNT_PROJECTS; index += 1) {
        project(db, `p${index}`, 'owner', index === 0 ? 'deleted' : 'active');
      }
      expect(() => project(db, 'extra')).toThrow(/project_account_count_quota/);
      project(db, 'other', 'other_owner');
      db.prepare('DELETE FROM projects WHERE id = ?').run('p0');
      project(db, 'extra');
    } finally {
      db.close();
    }
  });

  it('accounts for document objects and assets across projects and releases deleted rows', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db);
      project(db, 'p1', 'owner', 'deleted');
      project(db, 'p2');
      object(db, 'o1', 'p1', MAX_ACCOUNT_PROJECT_STORAGE_BYTES - 10);
      asset(db, 'a1', 'p2', 10);
      expect(() => object(db, 'o2', 'p2', 1)).toThrow(
        /project_account_storage_quota/
      );
      expect(() => asset(db, 'a2', 'p2', 1)).toThrow(
        /project_account_storage_quota/
      );
      object(db, 'other_object', 'p2', 0);
      asset(db, 'a1', 'p2', 10); // Existing content-addressed row costs no more.
      expect(() =>
        db
          .prepare(
            'UPDATE project_document_objects SET stored_bytes = 0 WHERE id = ?'
          )
          .run('o1')
      ).toThrow(/project_account_storage_immutable/);
      db.prepare('DELETE FROM project_document_objects WHERE id = ?').run('o1');
      object(db, 'o2', 'p2', 1);
    } finally {
      db.close();
    }
  });

  it('bounds legacy D1 heads and revisions with replacement credit', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db);
      project(db, 'legacy');
      const near = MAX_ACCOUNT_PROJECT_STORAGE_BYTES - 10;
      db.prepare('UPDATE projects SET document_bytes = ? WHERE id = ?').run(
        near,
        'legacy'
      );
      db.prepare(
        `INSERT INTO revisions (id, project_id, reason, document_json, document_bytes, created_at)
         VALUES ('r1', 'legacy', 'save', '{}', 10, '2026-01-01T00:00:00.000Z')`
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO revisions (id, project_id, reason, document_json, document_bytes, created_at)
         VALUES ('r2', 'legacy', 'save', '{}', 1, '2026-01-01T00:00:00.000Z')`
          )
          .run()
      ).toThrow(/project_account_document_quota/);
      db.prepare(
        `INSERT OR REPLACE INTO revisions
         (id, project_id, reason, document_json, document_bytes, created_at)
         VALUES ('r1', 'legacy', 'save', '{}', 10, '2026-01-01T00:00:00.000Z')`
      ).run();
      expect(() =>
        db
          .prepare('UPDATE projects SET document_bytes = ? WHERE id = ?')
          .run(near + 1, 'legacy')
      ).toThrow(/project_account_document_quota/);
      expect(() =>
        db
          .prepare(
            'INSERT INTO projects (id, user_id, name, document_json, document_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(
            'another',
            'owner',
            'another',
            '{}',
            1,
            '2026-01-01T00:00:00.000Z'
          )
      ).toThrow(/project_account_document_quota/);
      db.prepare('DELETE FROM revisions WHERE id = ?').run('r1');
      db.prepare('UPDATE projects SET document_bytes = ? WHERE id = ?').run(
        near + 1,
        'legacy'
      );
    } finally {
      db.close();
    }
  });

  it('installs on existing over-limit accounts and blocks only new growth', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, '0018');
      for (let index = 0; index <= MAX_ACCOUNT_PROJECTS; index += 1) {
        project(db, `old${index}`);
      }
      object(db, 'old_object', 'old0', MAX_ACCOUNT_PROJECT_STORAGE_BYTES + 1);
      db.exec(
        readFileSync(
          new URL('0019_project_account_quotas.sql', MIGRATIONS),
          'utf8'
        )
      );
      expect(() => project(db, 'new')).toThrow(/project_account_count_quota/);
      expect(() => object(db, 'new_object', 'old0', 1)).toThrow(
        /project_account_storage_quota/
      );
      db.prepare('DELETE FROM project_document_objects WHERE id = ?').run(
        'old_object'
      );
      db.prepare('DELETE FROM projects WHERE id = ?').run('old100');
      db.prepare('DELETE FROM projects WHERE id = ?').run('old99');
      project(db, 'new');
    } finally {
      db.close();
    }
  });

  it('lets an existing over-limit D1 account shrink or replace without growth', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, '0018');
      project(db, 'legacy');
      db.prepare('UPDATE projects SET document_bytes = ? WHERE id = ?').run(
        MAX_ACCOUNT_PROJECT_STORAGE_BYTES + 5,
        'legacy'
      );
      db.exec(
        readFileSync(
          new URL('0019_project_account_quotas.sql', MIGRATIONS),
          'utf8'
        )
      );
      db.prepare('UPDATE projects SET document_bytes = ? WHERE id = ?').run(
        MAX_ACCOUNT_PROJECT_STORAGE_BYTES + 4,
        'legacy'
      );
      expect(() =>
        db
          .prepare('UPDATE projects SET document_bytes = ? WHERE id = ?')
          .run(MAX_ACCOUNT_PROJECT_STORAGE_BYTES + 5, 'legacy')
      ).toThrow(/project_account_document_quota/);
    } finally {
      db.close();
    }
  });
});
