import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

/** Real SQLite transaction semantics behind the subset of D1 used here. */
function store() {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../apps/web/migrations/', import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  const queries: string[] = [];
  const prepare = (query: string) => {
    queries.push(query);
    let values: SQLInputValue[] = [];
    const statement = {
      bind: (...bindings: SQLInputValue[]) => {
        values = bindings;
        return statement;
      },
      first: async () => db.prepare(query).get(...values) ?? null,
      all: async () => ({ results: db.prepare(query).all(...values) }),
      run: async () => ({
        success: true,
        meta: db.prepare(query).run(...values)
      })
    };
    return statement;
  };
  let batchTail = Promise.resolve();
  const binding = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      const previous = batchTail;
      let release!: () => void;
      batchTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        release();
      }
    }
  };
  return { db, queries, binding: binding as unknown as D1Database };
}

const owner = toUserId('owner');
const secondOwner = toUserId('second');

for (const useR2 of [false, true])
  describe(`account project bindings (${useR2 ? 'R2' : 'D1'})`, () => {
    const setup = () => {
      const fixture = store();
      const objects = new Map<string, ArrayBuffer>();
      const bucket = {
        put: async (key: string, body: ArrayBuffer) => {
          objects.set(key, body.slice(0));
        },
        get: async (key: string) => {
          const body = objects.get(key);
          return body ? { arrayBuffer: async () => body.slice(0) } : null;
        },
        delete: async (key: string) => {
          objects.delete(key);
        }
      };
      return {
        ...fixture,
        objects,
        service: new D1R2PersistenceService({
          DB: fixture.binding,
          ...(useR2 ? { PROJECT_STORAGE: bucket as unknown as R2Bucket } : {})
        })
      };
    };

    it('assigns identities independently of the supplied device identity and scopes retries by account', async () => {
      const { db, queries, service } = setup();
      try {
        const original = await service.createProject(owner, {
          name: 'Account original'
        });
        const absent = createProjectDocument(
          'Device original',
          toUserId('device')
        );
        const occupied = { ...original.document, name: 'Device original' };
        const first = await service.createProject(secondOwner, {
          name: absent.name,
          document: absent
        });
        const second = await service.createProject(secondOwner, {
          name: occupied.name,
          document: occupied
        });
        expect(first.document.projectId).not.toBe(absent.projectId);
        expect(second.document.projectId).not.toBe(occupied.projectId);
        expect(second.document.version).toBe(occupied.version);
        expect(second.document.revisions).toEqual(occupied.revisions);
        expect(second.document.derived.updatedAt).toBe(
          occupied.derived.updatedAt
        );
        await expect(
          service.createProject(secondOwner, {
            name: absent.name,
            document: absent
          })
        ).rejects.toMatchObject({
          code: 'ALREADY_ADOPTED',
          projectId: first.document.projectId
        });
        const otherAccount = await service.createProject(owner, {
          name: absent.name,
          document: absent
        });
        expect(otherAccount.document.projectId).not.toBe(
          first.document.projectId
        );
        await expect(
          service.createProject(owner, {
            name: original.document.name,
            document: original.document
          })
        ).rejects.toMatchObject({
          code: 'ALREADY_ADOPTED',
          projectId: original.document.projectId
        });
        expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({
          n: 4
        });
        expect(
          queries.some(
            (query) => query === 'SELECT user_id FROM projects WHERE id = ?'
          )
        ).toBe(false);
        expect(
          (await service.loadProject(owner, original.document.projectId))?.name
        ).toBe('Account original');
      } finally {
        db.close();
      }
    });

    it('recovers simultaneous retries with one project and one durable binding', async () => {
      const { db, service, objects } = setup();
      try {
        const source = createProjectDocument(
          'Concurrent adoption',
          toUserId('device')
        );
        const request = { name: source.name, document: source };
        const results = await Promise.allSettled([
          service.createProject(owner, request),
          service.createProject(owner, request)
        ]);
        const success = results.find((result) => result.status === 'fulfilled');
        const retry = results.find((result) => result.status === 'rejected');
        expect(success?.status).toBe('fulfilled');
        expect(retry?.status).toBe('rejected');
        if (success?.status !== 'fulfilled' || retry?.status !== 'rejected')
          throw new Error('Expected one acknowledged project');
        expect(retry.reason).toMatchObject({
          code: 'ALREADY_ADOPTED',
          projectId: success.value.document.projectId
        });
        expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({
          n: 1
        });
        expect(
          db.prepare('SELECT COUNT(*) AS n FROM project_adoptions').get()
        ).toEqual({ n: 1 });
        if (useR2) expect(objects.size).toBe(1);
        await service.deleteProject(owner, success.value.document.projectId);
        expect(
          db.prepare('SELECT COUNT(*) AS n FROM project_adoptions').get()
        ).toEqual({ n: 0 });
        const recreated = await service.createProject(owner, request);
        expect(recreated.document.projectId).not.toBe(
          success.value.document.projectId
        );
      } finally {
        db.close();
      }
    });
  });
