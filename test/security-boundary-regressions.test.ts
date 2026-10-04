import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  evaluateExpression,
  renameNode
} from '@openzcad/document-core';
import { InMemoryPersistenceService } from '@openzcad/persistence';
import {
  documentEnvelopeError,
  documentStructureError,
  JsonComplexityGuard,
  toUserId
} from '@openzcad/shared';
import { glbPlacement } from '../packages/kernel-adapter/src/glb-scene';
import {
  MAX_THREE_MF_PLACEMENTS,
  readThreeMfPackage
} from '../packages/kernel-adapter/src/three-mf-package';
import { decodeProjectStorageBody } from '../packages/cloudflare-adapters/src/project-object-storage';
import { deflatedThreeMfFixture } from './support/mesh-import-fixtures';

function glb(nodes: unknown[], roots = [0]): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({ nodes, meshes: [{}], scenes: [{ nodes: roots }] })
  );
  const bytes = new Uint8Array(20 + json.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(json, 20);
  return bytes;
}

describe('security resource and persistence boundaries', () => {
  it('refuses deep and broad documents before recursive normalization', () => {
    let deep: unknown = {};
    for (let i = 0; i < 80; i++) deep = { nested: deep };
    expect(documentStructureError(deep)).toMatch(/deeper/);
    expect(documentStructureError(Array(500_001).fill(null))).toMatch(/values/);
    const ordinary = createProjectDocument('Ordinary', toUserId('user_test'));
    expect(documentStructureError(ordinary)).toBeNull();
    expect(
      documentStructureError(
        renameNode(ordinary, {
          nodeId: ordinary.rootNodeId,
          name: 'N'.repeat(201)
        })
      )
    ).toBeNull();
  });

  it.each([1e308, -1, 1.5, NaN])(
    'refuses invalid document version %s',
    (version) => {
      expect(
        documentEnvelopeError({
          ...createProjectDocument('Version', toUserId('user_test')),
          version
        })
      ).not.toBeNull();
    }
  );

  it('tracks JSON nesting across chunks and ignores brackets inside escaped strings', () => {
    const guard = new JsonComplexityGuard(3, 100);
    guard.consume('{"value":"[[[\\');
    guard.consume('"[[[","ok":[{}]}');
    expect(() => new JsonComplexityGuard(3).consume('[[[[]]]]')).toThrow(
      /structural/
    );
  });

  it.each([
    '('.repeat(300) + '1' + ')'.repeat(300),
    '-'.repeat(300) + '1',
    '2^'.repeat(300) + '1',
    '1'.repeat(5000)
  ])('refuses hostile expressions with a named limit', (expression) => {
    expect(() => evaluateExpression(expression, {})).toThrow(
      /limit|exceed|long/i
    );
    expect(evaluateExpression('sqrt(81) + 2^3', {})).toBe(17);
  });

  it('refuses GLB cycles and repeated descendants while preserving valid placement', () => {
    expect(() => glbPlacement(glb([{ children: [0] }]))).toThrow(/cycle/);
    expect(() =>
      glbPlacement(glb([{ children: [1, 1] }, { mesh: 0 }]))
    ).toThrow(/repeated/);
    expect(glbPlacement(glb([{ children: [1] }, { mesh: 0 }]))).toHaveLength(
      12
    );
    expect(() =>
      glbPlacement(
        glb(
          Array.from({ length: 20_000 }, () => ({ mesh: 0 })),
          Array.from({ length: 20_000 }, (_, index) => index)
        )
      )
    ).toThrow(/more than once/);
  });

  it('rejects excessive 3MF placement expansion before invoking the kernel', async () => {
    const bytes = await deflatedThreeMfFixture({
      items: Array.from({ length: MAX_THREE_MF_PLACEMENTS + 1 }, () => ({
        objectid: 1
      }))
    });
    await expect(readThreeMfPackage(bytes)).rejects.toThrow(/limit/);
    expect(
      (
        await readThreeMfPackage(
          await deflatedThreeMfFixture({ items: [{ objectid: 1 }] })
        )
      ).placements
    ).toHaveLength(1);
  });

  it('accepts exactly the 3MF placement limit with closing tags still to scan', async () => {
    const bytes = await deflatedThreeMfFixture({
      items: Array.from({ length: MAX_THREE_MF_PLACEMENTS }, () => ({
        objectid: 1
      }))
    });
    expect((await readThreeMfPackage(bytes)).placements).toHaveLength(
      MAX_THREE_MF_PLACEMENTS
    );
  });

  it('accepts exactly 10,000 3MF objects and refuses the next object', async () => {
    expect(
      (
        await readThreeMfPackage(
          await deflatedThreeMfFixture({ objects: 10_000 })
        )
      ).meshObjectCount
    ).toBe(10_000);
    await expect(
      readThreeMfPackage(await deflatedThreeMfFixture({ objects: 10_001 }))
    ).rejects.toThrow(/object count.*limit/);
  });

  it('stops gzip output at its declared logical length', async () => {
    const compressed = await new Response(
      new Blob(['x'.repeat(100_000)])
        .stream()
        .pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();
    await expect(
      decodeProjectStorageBody(compressed, 'gzip', 100)
    ).rejects.toThrow(/length|limit/);
    expect(
      (await decodeProjectStorageBody(compressed, 'gzip', 100_000)).length
    ).toBe(100_000);
  });

  it('mints distinct saved revisions for identical client-selected revision IDs', async () => {
    const user = toUserId('user_saved_revision');
    const service = new InMemoryPersistenceService();
    const project = await service.createProject(user, { name: 'Snapshots' });
    const loaded = await service.loadProject(user, project.document.projectId);
    const first = await service.saveRevision(user, {
      projectId: project.document.projectId,
      document: loaded!,
      expectedVersion: loaded!.version,
      reason: 'first'
    });
    const second = await service.saveRevision(user, {
      projectId: project.document.projectId,
      document: first,
      expectedVersion: first.version,
      reason: 'second'
    });
    const { revisions } = await service.listRevisions(
      user,
      project.document.projectId
    );
    expect(new Set(revisions.map((revision) => revision.revisionId)).size).toBe(
      revisions.length
    );
    expect(second.version).toBe(first.version);
    expect(revisions.map((revision) => revision.reason)).toEqual(
      expect.arrayContaining(['first', 'second'])
    );
  });
});

describe('workspace and adoption erasure fences', () => {
  it.each(['owner', 'member'])(
    'blocks late insert/update for an erasing %s even with foreign keys disabled',
    (erasing) => {
      const db = new DatabaseSync(':memory:');
      try {
        const dir = new URL('../apps/web/migrations/', import.meta.url);
        for (const name of readdirSync(dir)
          .filter((name) => name.endsWith('.sql'))
          .sort())
          db.exec(readFileSync(new URL(name, dir), 'utf8'));
        db.exec(
          "PRAGMA foreign_keys = OFF; INSERT INTO projects (id,user_id,name,document_json,updated_at) VALUES ('project','owner','P','{}','now')"
        );
        const workspace = db.prepare(
          "INSERT INTO project_workspace_sessions VALUES ('member','project','session','device',1,'{}','now')"
        );
        const adoption = db.prepare(
          "INSERT INTO project_adoptions VALUES ('member','local','project')"
        );
        workspace.run();
        adoption.run();
        db.prepare(
          "INSERT INTO account_erasure_requests VALUES (?,'all',1,1)"
        ).run(erasing);
        expect(() =>
          db.prepare('UPDATE project_workspace_sessions SET sequence=2').run()
        ).toThrow(/ACCOUNT_ERASURE/);
        expect(() =>
          db
            .prepare("UPDATE project_adoptions SET local_project_id='new'")
            .run()
        ).toThrow(/ACCOUNT_ERASURE/);
        db.exec(
          'DELETE FROM project_workspace_sessions; DELETE FROM project_adoptions'
        );
        expect(() => workspace.run()).toThrow(/ACCOUNT_ERASURE/);
        expect(() => adoption.run()).toThrow(/ACCOUNT_ERASURE/);
      } finally {
        db.close();
      }
    }
  );
});

describe('access metadata bounds', () => {
  it('caps active links and retains recent audit/revocation records per project', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const dir = new URL('../apps/web/migrations/', import.meta.url);
      for (const name of readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort())
        db.exec(readFileSync(new URL(name, dir), 'utf8'));
      db.exec(
        "PRAGMA foreign_keys=OFF; INSERT INTO projects (id,user_id,name,document_json,updated_at) VALUES ('project','owner','P','{}','now')"
      );
      const link = db.prepare(
        "INSERT INTO project_share_links (id,project_id,mode,token_hash,created_by_user_id,created_at) VALUES (?,'project','tweak',?,'owner',1)"
      );
      for (let i = 0; i < 100; i++) link.run(`link_${i}`, `hash_${i}`);
      expect(() => link.run('over', 'over')).toThrow(/SHARE_LINK_LIMIT/);
      for (let i = 0; i < 101; i++) {
        const id = i < 100 ? `link_${i}` : 'after';
        if (i === 100) link.run(id, id);
        db.prepare(
          'UPDATE project_share_links SET revoked_at=2 WHERE id=?'
        ).run(id);
      }
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM project_share_links WHERE revoked_at IS NOT NULL'
          )
          .get()
      ).toEqual({ count: 100 });
      const event = db.prepare(
        "INSERT INTO project_access_events (project_id,event_type,created_at) VALUES ('project','member-removed',?)"
      );
      for (let i = 0; i < 1010; i++) event.run(i);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM project_access_events'
          )
          .get()
      ).toEqual({ count: 1000, oldest: 10 });
    } finally {
      db.close();
    }
  });
});
