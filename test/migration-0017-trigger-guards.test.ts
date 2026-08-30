import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Migration 0017's trigger guards were rewritten from `SELECT CASE WHEN …
 * THEN RAISE(ABORT, …) END;` to one `SELECT RAISE(ABORT, …) WHERE …;` per
 * branch, because a `CASE` inside a trigger body ends the statement early for
 * D1's splitter (see `d1-migration-split.test.ts`).
 *
 * The rewrite is only equivalent if each branch still aborts on exactly the
 * state it used to, so every abort label gets a case here. The multipart
 * accounting suite covers the four labels it happens to reach through the
 * service; these are the rest, driven as raw SQL because that is the layer
 * the triggers live at.
 */

const MIGRATIONS = new URL('../apps/web/migrations/', import.meta.url);
const OWNER = 'user_guard_owner';
const PROJECT = 'project_guard_owner';
const QUOTA = 2147483648;

let db: DatabaseSync;

function applyMigrations(target: DatabaseSync): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    target.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
}

interface SessionRow {
  id: string;
  artifact_id: string;
  project_id: string;
  object_key: string;
  file_name: string;
  content_type: string;
  expires_at: string;
  kind: string;
  metadata_json: string;
  owner_user_id: string | null;
  reserved_bytes: number;
  reservation_state: string;
  multipart_upload_id: string | null;
  completion_started_at: number | null;
}

/** A session row in the one shape the insert guard accepts. */
function insertSession(overrides: Partial<SessionRow> = {}): void {
  const row = {
    id: 'session_1',
    artifact_id: 'artifact_1',
    project_id: PROJECT,
    object_key: 'key_1',
    file_name: 'assembly.step',
    content_type: 'model/step',
    expires_at: '2099-01-01T00:00:00.000Z',
    kind: 'snapshot',
    metadata_json: '{}',
    owner_user_id: OWNER,
    reserved_bytes: 0,
    reservation_state: 'open',
    multipart_upload_id: null,
    completion_started_at: null,
    ...overrides
  };
  db.prepare(
    `INSERT INTO upload_sessions (
       id, artifact_id, project_id, object_key, file_name, content_type,
       expires_at, kind, metadata_json, owner_user_id, reserved_bytes,
       reservation_state, multipart_upload_id, completion_started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.artifact_id,
    row.project_id,
    row.object_key,
    row.file_name,
    row.content_type,
    row.expires_at,
    row.kind,
    row.metadata_json,
    row.owner_user_id,
    row.reserved_bytes,
    row.reservation_state,
    row.multipart_upload_id,
    row.completion_started_at
  );
}

interface ArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  object_key: string;
  content_type: string;
  metadata_json: string;
  created_at: string;
  bytes: number | null;
}

function insertArtifact(overrides: Partial<ArtifactRow> = {}): void {
  const row = {
    id: 'artifact_final',
    project_id: PROJECT,
    kind: 'snapshot',
    name: 'assembly.step',
    object_key: 'final_key',
    content_type: 'model/step',
    metadata_json: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    bytes: 1024,
    ...overrides
  };
  db.prepare(
    `INSERT INTO artifacts (
       id, project_id, kind, name, object_key, content_type, metadata_json,
       created_at, bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.project_id,
    row.kind,
    row.name,
    row.object_key,
    row.content_type,
    row.metadata_json,
    row.created_at,
    row.bytes
  );
}

/** Move the session into the state the part triggers require. */
function beginMultipart(sessionId = 'session_1'): void {
  db.prepare(
    `UPDATE upload_sessions
     SET reservation_state = 'uploading', multipart_upload_id = 'r2_upload_1'
     WHERE id = ?`
  ).run(sessionId);
}

function insertPart(partNumber: number, bytes = 1024): void {
  db.prepare(
    `INSERT INTO artifact_upload_parts (
       upload_session_id, part_number, bytes, etag, reservation_token
     ) VALUES ('session_1', ?, ?, NULL, 'token')`
  ).run(partNumber, bytes);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  applyMigrations(db);
  db.prepare(
    `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`
  ).run(OWNER, `${OWNER}@example.com`, '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES (?, ?, 'Guard project', '{}', ?)`
  ).run(PROJECT, OWNER, '2026-01-01T00:00:00.000Z');
});

describe('upload session insert guards', () => {
  it('admits a well-formed session', () => {
    expect(() => insertSession()).not.toThrow();
  });

  it('refuses a session with no owner', () => {
    expect(() => insertSession({ owner_user_id: null })).toThrow(
      /artifact_upload_owner_required/
    );
    expect(() => insertSession({ owner_user_id: '' })).toThrow(
      /artifact_upload_owner_required/
    );
  });

  it.each([
    ['a non-open state', { reservation_state: 'uploading' }],
    ['pre-charged bytes', { reserved_bytes: 512 }],
    ['a multipart id', { multipart_upload_id: 'r2_upload_1' }],
    ['a completion stamp', { completion_started_at: 1 }]
  ])('refuses a session opening with %s', (_label, overrides) => {
    expect(() => insertSession(overrides)).toThrow(
      /artifact_upload_initial_state_invalid/
    );
  });

  it('refuses the seventeenth concurrent session', () => {
    for (let index = 0; index < 16; index += 1) {
      insertSession({
        id: `session_${index}`,
        artifact_id: `artifact_${index}`,
        object_key: `key_${index}`
      });
    }
    expect(() =>
      insertSession({
        id: 'session_over',
        artifact_id: 'artifact_over',
        object_key: 'key_over'
      })
    ).toThrow(/artifact_upload_session_limit/);
  });

  it('refuses a session opened at account quota', () => {
    insertSession();
    db.prepare(
      `UPDATE artifact_account_usage SET finalized_bytes = ?
       WHERE owner_user_id = ?`
    ).run(QUOTA, OWNER);
    expect(() =>
      insertSession({
        id: 'session_2',
        artifact_id: 'artifact_2',
        object_key: 'key_2'
      })
    ).toThrow(/artifact_account_quota/);
  });
});

describe('artifact finalization guards', () => {
  it('admits a well-formed artifact', () => {
    expect(() => insertArtifact()).not.toThrow();
  });

  it.each([
    ['null bytes', { bytes: null }],
    ['negative bytes', { bytes: -1 }]
  ])('refuses an artifact with %s', (_label, overrides) => {
    expect(() => insertArtifact(overrides)).toThrow(
      /artifact_finalized_bytes_invalid/
    );
  });

  it('refuses an artifact whose project is gone', () => {
    // The foreign key is not enforced by default in this connection, so the
    // trigger is the only thing standing between a stray project id and an
    // unattributable byte count.
    expect(() => insertArtifact({ project_id: 'project_missing' })).toThrow(
      /artifact_project_owner_missing/
    );
  });

  it('refuses an artifact that would cross account quota', () => {
    insertSession();
    db.prepare(
      `UPDATE artifact_account_usage SET finalized_bytes = ?
       WHERE owner_user_id = ?`
    ).run(QUOTA, OWNER);
    expect(() => insertArtifact()).toThrow(/artifact_account_quota/);
  });
});

describe('upload part guards', () => {
  beforeEach(() => {
    insertSession();
    beginMultipart();
  });

  it('admits a part on an uploading session', () => {
    expect(() => insertPart(1)).not.toThrow();
  });

  it('refuses a part when the session is not uploading', () => {
    db.prepare(
      `UPDATE upload_sessions SET reservation_state = 'completing' WHERE id = ?`
    ).run('session_1');
    expect(() => insertPart(1)).toThrow(/artifact_multipart_not_uploading/);
  });

  it('refuses the sixty-fifth part', () => {
    for (let part = 1; part <= 64; part += 1) {
      insertPart(part, 1);
    }
    expect(() => insertPart(65, 1)).toThrow(/artifact_upload_part_limit/);
  });

  it('still allows replacing an existing part at the limit', () => {
    for (let part = 1; part <= 64; part += 1) {
      insertPart(part, 1);
    }
    expect(() =>
      db
        .prepare(
          `UPDATE artifact_upload_parts SET bytes = 2
           WHERE upload_session_id = 'session_1' AND part_number = 64`
        )
        .run()
    ).not.toThrow();
  });

  it('refuses moving a part to another session or number', () => {
    insertPart(1);
    expect(() =>
      db
        .prepare(
          `UPDATE artifact_upload_parts SET part_number = 2
           WHERE upload_session_id = 'session_1' AND part_number = 1`
        )
        .run()
    ).toThrow(/artifact_upload_part_identity_immutable/);
  });

  it.each([
    ['zero bytes', 'bytes = 0'],
    ['oversized bytes', 'bytes = 33554433'],
    ['an empty reservation token', `reservation_token = ''`]
  ])('refuses updating a part to %s', (_label, assignment) => {
    insertPart(1);
    expect(() =>
      db
        .prepare(
          `UPDATE artifact_upload_parts SET ${assignment}
           WHERE upload_session_id = 'session_1' AND part_number = 1`
        )
        .run()
    ).toThrow(/artifact_upload_part_invalid/);
  });

  it('refuses updating a part once the session stopped uploading', () => {
    insertPart(1);
    db.prepare(
      `UPDATE upload_sessions SET reservation_state = 'completing' WHERE id = ?`
    ).run('session_1');
    expect(() =>
      db
        .prepare(
          `UPDATE artifact_upload_parts SET bytes = 2048
           WHERE upload_session_id = 'session_1' AND part_number = 1`
        )
        .run()
    ).toThrow(/artifact_multipart_not_uploading/);
  });
});
