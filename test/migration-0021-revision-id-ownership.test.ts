import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../apps/web/migrations/', import.meta.url);

function migrate(db: DatabaseSync, through = '0021'): void {
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql') && name.slice(0, 4) <= through)
    .sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
}

function project(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES (?, ?, ?, '{}', '2026-01-01T00:00:00.000Z')`
  ).run(id, id, id);
}

describe('migration 0021 revision ID ownership', () => {
  it.each(['D1 document', 'R2 pointer'] as const)(
    'rejects cross-project replacement of a %s revision without advancing the head',
    (mode) => {
      const db = new DatabaseSync(':memory:');
      try {
        migrate(db);
        project(db, 'victim');
        project(db, 'attacker');
        const pointer = mode === 'R2 pointer' ? 'attacker-object' : null;
        if (pointer) {
          db.prepare(
            `INSERT INTO project_document_objects
              (id, project_id, object_key, checksum_sha256, logical_bytes,
               stored_bytes, content_encoding, state, created_at)
             VALUES (?, 'attacker', ?, 'sha', 1, 1, 'gzip', 'committed',
               '2026-01-01T00:00:00.000Z')`
          ).run(pointer, pointer);
        }
        const revision = db.prepare(
          `INSERT OR REPLACE INTO revisions
            (id, project_id, reason, document_json, document_object_id,
             document_bytes, created_at)
           VALUES ('shared-id', ?, 'save', ?, ?, 1,
             '2026-01-01T00:00:00.000Z')`
        );
        revision.run('victim', 'victim-body', null);

        db.exec('BEGIN IMMEDIATE');
        db.prepare(
          `UPDATE projects SET document_version = document_version + 1,
             last_revision_id = 'shared-id' WHERE id = 'attacker'`
        ).run();
        expect(() =>
          revision.run('attacker', 'attacker-body', pointer)
        ).toThrow(/revision_project_collision/);
        db.exec('ROLLBACK');

        expect(
          db
            .prepare(
              `SELECT project_id, document_json, document_object_id
             FROM revisions WHERE id = 'shared-id'`
            )
            .get()
        ).toEqual({
          project_id: 'victim',
          document_json: 'victim-body',
          document_object_id: null
        });
        expect(
          db
            .prepare(
              `SELECT document_version, last_revision_id FROM projects
             WHERE id = 'attacker'`
            )
            .get()
        ).toEqual({ document_version: 0, last_revision_id: null });

        revision.run('victim', 'same-project-replacement', null);
        expect(
          db
            .prepare(
              "SELECT document_json FROM revisions WHERE id = 'shared-id'"
            )
            .get()
        ).toEqual({ document_json: 'same-project-replacement' });
      } finally {
        db.close();
      }
    }
  );
});
