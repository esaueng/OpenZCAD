import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadWorkspaceSessions,
  parseWorkspaceSession,
  saveWorkspaceSession
} from '../apps/web/worker/workspaceSessions';

let sqlite: DatabaseSync;
let db: D1Database;
function input(sequence = 1, sessionId = 'session_a') {
  return parseWorkspaceSession(
    {
      schemaVersion: 1,
      projectId: 'project_a',
      deviceId: 'device_a',
      sessionId,
      deviceLabel: 'Desktop',
      documentVersion: 2,
      sequence,
      state: {
        camera: {
          position: [10, 20, 30],
          target: [0, 0, 0],
          orthographicZoom: 1
        },
        projection: 'orthographic',
        settings: { showGrid: false, displayMode: 'shaded' },
        hiddenBodyIds: ['body_a'],
        selectedBodyIds: ['body_b'],
        workspaceMode: 'build',
        panels: {
          sidebarSections: { history: false },
          assistantCollapsed: true,
          viewModeRailOpen: true
        }
      }
    },
    'project_a'
  );
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY, document_version INTEGER);
    INSERT INTO users VALUES ('user_a'), ('user_b');
    INSERT INTO projects VALUES ('project_a', 2), ('project_b', 2);`);
  sqlite.exec(
    readFileSync(
      new URL(
        '../apps/web/migrations/0018_workspace_sessions.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db = {
    prepare(query: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async first() {
          return sqlite.prepare(query).get(...(bindings as never[])) ?? null;
        },
        async all() {
          return {
            results: sqlite.prepare(query).all(...(bindings as never[]))
          };
        },
        async run() {
          const result = sqlite.prepare(query).run(...(bindings as never[]));
          return { meta: { changes: Number(result.changes) } };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
});
afterEach(() => sqlite.close());

describe('private workspace sessions', () => {
  it('isolates accounts and projects and ignores retries and out-of-order updates', async () => {
    await saveWorkspaceSession(db, 'user_a', input(2));
    await saveWorkspaceSession(db, 'user_a', input(1));
    await saveWorkspaceSession(db, 'user_a', input(2));
    expect(await loadWorkspaceSessions(db, 'user_b', 'project_a')).toEqual([]);
    expect(await loadWorkspaceSessions(db, 'user_a', 'project_b')).toEqual([]);
    const sessions = await loadWorkspaceSessions(db, 'user_a', 'project_a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sequence).toBe(2);
    expect(sessions[0]?.state.camera.position).toEqual([10, 20, 30]);
  });

  it('refuses a session ahead of the durable model and accepts it after model sync', async () => {
    await expect(
      saveWorkspaceSession(db, 'user_a', { ...input(), documentVersion: 3 })
    ).rejects.toThrow('Sync the project');
    sqlite.exec("UPDATE projects SET document_version=3 WHERE id='project_a'");
    await saveWorkspaceSession(db, 'user_a', {
      ...input(),
      documentVersion: 3
    });
    expect(await loadWorkspaceSessions(db, 'user_a', 'project_a')).toHaveLength(
      1
    );
  });

  it('bounds per-project sessions and removes them with project or account deletion', async () => {
    for (let n = 0; n < 25; n++)
      await saveWorkspaceSession(db, 'user_a', input(1, `session_${n}`));
    expect(await loadWorkspaceSessions(db, 'user_a', 'project_a')).toHaveLength(
      20
    );
    await saveWorkspaceSession(db, 'user_b', input());
    sqlite.exec("DELETE FROM users WHERE id='user_a'");
    expect(await loadWorkspaceSessions(db, 'user_a', 'project_a')).toHaveLength(
      0
    );
    expect(await loadWorkspaceSessions(db, 'user_b', 'project_a')).toHaveLength(
      1
    );
    sqlite.exec("DELETE FROM projects WHERE id='project_a'");
    expect(await loadWorkspaceSessions(db, 'user_b', 'project_a')).toHaveLength(
      0
    );
  });

  it('rejects invalid camera values and foreign identities while stripping unknown view fields', () => {
    expect(() =>
      parseWorkspaceSession({ ...input(), projectId: 'project_b' }, 'project_a')
    ).toThrow('Invalid workspace');
    const invalid = input();
    invalid.state.camera.position[0] = Infinity;
    expect(() => parseWorkspaceSession(invalid, 'project_a')).toThrow(
      'Invalid workspace'
    );
    const value = input();
    Object.assign(value.state, { secret: 'synthetic-test-value' });
    expect(parseWorkspaceSession(value, 'project_a').state).not.toHaveProperty(
      'secret'
    );
  });
});
