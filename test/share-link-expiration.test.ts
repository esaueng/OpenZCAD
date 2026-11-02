import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { InMemoryPersistenceService } from '@openzcad/persistence';
import {
  PROJECT_SHARE_LINK_TTL_SECONDS,
  toArtifactId,
  toUserId,
  type CreateProjectResponse,
  type CreateProjectShareLinkResponse,
  type ProjectShareLinkMode
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { hashProjectInvitationToken } from '../apps/web/worker/sharing';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const CREATED_AT = 1_800_000_000;
const EXPIRES_AT = CREATED_AT + 30 * 24 * 60 * 60;
const OWNER = toUserId('user_expiring_share');
const TOKEN = 'e'.repeat(43);
const ARTIFACT = toArtifactId('artifact_expiring_step');
const SOURCE = new TextEncoder().encode('ISO-10303-21;');

afterEach(() => vi.restoreAllMocks());

async function d1Fixture(
  mode: ProjectShareLinkMode,
  onDocumentRead?: () => void
) {
  const db = migratedDatabase();
  const document = importStepBody(createProjectDocument('Bracket', OWNER), {
    name: 'Imported bracket',
    sourceName: 'bracket.step',
    artifactId: ARTIFACT,
    stepSourceRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: await hashProjectInvitationToken(
        new TextDecoder().decode(SOURCE)
      ),
      logicalBytes: SOURCE.byteLength
    }
  }).document;
  const projectId = document.projectId;
  const tokenHash = await hashProjectInvitationToken(TOKEN);
  const iso = new Date(CREATED_AT * 1000).toISOString();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    OWNER,
    'share@example.com',
    iso
  );
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(projectId, OWNER, document.name, JSON.stringify(document), iso);
  // Insert the existing schema directly: links predating this policy have
  // only created_at, so migration-free enforcement must cover this row too.
  db.prepare(
    `INSERT INTO project_share_links
       (id, project_id, mode, token_hash, created_by_user_id, created_at)
     VALUES ('share_expiring', ?, ?, ?, ?, ?)`
  ).run(projectId, mode, tokenHash, OWNER, CREATED_AT);
  db.prepare(
    `INSERT INTO artifacts
       (id, project_id, kind, name, object_key, content_type, metadata_json,
        created_at, bytes)
     VALUES (?, ?, 'step-import', 'bracket.step', 'source', 'application/step',
             '{}', ?, ?)`
  ).run(ARTIFACT, projectId, iso, SOURCE.byteLength);
  db.prepare(
    `INSERT INTO project_storage_assets
       (id, project_id, kind, object_key, checksum_sha256, logical_bytes,
        stored_bytes, content_encoding, created_at)
     VALUES ('asset_expiring', ?, 'step-source', 'asset', ?, ?, ?, 'gzip', ?)`
  ).run(
    projectId,
    await hashProjectInvitationToken(new TextDecoder().decode(SOURCE)),
    SOURCE.byteLength,
    gzipSync(SOURCE).byteLength,
    iso
  );
  const get = vi.fn(async (key: string) => {
    const body = key === 'asset' ? gzipSync(SOURCE) : SOURCE;
    return {
      arrayBuffer: async () => Uint8Array.from(body).buffer,
      body: new Response(Uint8Array.from(body)).body
    };
  });
  const env = {
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    PROJECT_SHARING_ENABLED: 'true',
    DB: sqliteD1(db, {
      onStatement(sql) {
        if (sql.includes('FROM project_share_links l')) onDocumentRead?.();
      }
    }),
    ARTIFACTS: { get, put: vi.fn(), delete: vi.fn() } as unknown as R2Bucket
  };
  return {
    db,
    env,
    service: new D1R2PersistenceService(env),
    tokenHash,
    projectId,
    get
  };
}

describe('share-link expiration', () => {
  it('uses a fixed 30-day lifetime in Unix seconds', () => {
    expect(PROJECT_SHARE_LINK_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it.each(['tweak', 'view'] as const)(
    'expires in-memory %s links at the exact boundary without sliding on reads',
    async (mode) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(CREATED_AT * 1000);
      const service = new InMemoryPersistenceService();
      const { document } = await service.createProject(OWNER, { name: 'Part' });
      const link = await service.createProjectShareLink(
        OWNER,
        document.projectId,
        {
          shareLinkId: 'share_memory',
          mode,
          tokenHash: 'memory_hash',
          createdAt: CREATED_AT
        }
      );
      now.mockReturnValue(EXPIRES_AT * 1000 - 1);
      await expect(
        service.loadSharedProjectByTokenHash('memory_hash')
      ).resolves.toMatchObject({ mode });
      for (const offset of [0, 1]) {
        now.mockReturnValue((EXPIRES_AT + offset) * 1000);
        await expect(
          service.loadSharedProjectByTokenHash('memory_hash')
        ).resolves.toBeNull();
      }
      // Expiration does not erase the owner's control or silently mint a new token.
      await expect(
        service.listProjectShareLinks(OWNER, document.projectId)
      ).resolves.toEqual([link]);
      await service.revokeProjectShareLink(
        OWNER,
        document.projectId,
        link.shareLinkId,
        EXPIRES_AT + 1
      );
      await expect(
        service.listProjectShareLinks(OWNER, document.projectId)
      ).resolves.toEqual([]);
    }
  );

  it.each(['tweak', 'view'] as const)(
    'expires legacy D1 %s document, asset, and source reads together',
    async (mode) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(EXPIRES_AT * 1000 - 1);
      const { db, service, tokenHash, projectId, get } = await d1Fixture(mode);
      try {
        await expect(
          service.loadSharedProjectByTokenHash(tokenHash)
        ).resolves.toMatchObject({ projectId, mode });
        const asset = await service.loadSharedProjectAsset(
          tokenHash,
          'asset_expiring'
        );
        expect(new Uint8Array(asset!.body)).toEqual(SOURCE);
        const source = await service.loadSharedProjectImportSource(
          tokenHash,
          ARTIFACT
        );
        expect(
          new Uint8Array(await new Response(source!.body).arrayBuffer())
        ).toEqual(SOURCE);
        get.mockClear();
        for (const offset of [0, 1]) {
          now.mockReturnValue((EXPIRES_AT + offset) * 1000);
          await expect(
            service.loadSharedProjectByTokenHash(tokenHash)
          ).resolves.toBeNull();
          await expect(
            service.loadSharedProjectAsset(tokenHash, 'asset_expiring')
          ).resolves.toBeNull();
          await expect(
            service.loadSharedProjectImportSource(tokenHash, ARTIFACT)
          ).resolves.toBeNull();
        }
        expect(get).not.toHaveBeenCalled();
        const links = await service.listProjectShareLinks(OWNER, projectId);
        expect(links).toHaveLength(1);
        expect(links[0]).toMatchObject({
          shareLinkId: 'share_expiring',
          createdAt: CREATED_AT,
          revokedAt: null
        });
        await service.revokeProjectShareLink(
          OWNER,
          projectId,
          'share_expiring',
          EXPIRES_AT + 1
        );
        await expect(
          service.listProjectShareLinks(OWNER, projectId)
        ).resolves.toEqual([]);
      } finally {
        db.close();
      }
    }
  );

  it('rechecks expiration after loading a document before fetching its source', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(EXPIRES_AT * 1000 - 1);
    const { db, service, tokenHash, get } = await d1Fixture('tweak', () => {
      // The document SELECT already bound its valid timestamp; advance time
      // during execution so the later source SELECT must sample it again.
      now.mockReturnValue(EXPIRES_AT * 1000);
    });
    try {
      await expect(
        service.loadSharedProjectImportSource(tokenHash, ARTIFACT)
      ).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('keeps expired, revoked, malformed and unknown public reads equally opaque', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(EXPIRES_AT * 1000 - 1);
    const { db, env } = await d1Fixture('view');
    const read = (token: string, suffix: string) =>
      worker.fetch(
        new Request(`https://example.com/api/share/${token}${suffix}`),
        env
      );
    try {
      for (const suffix of [
        '',
        '/assets/asset_expiring',
        `/sources/${ARTIFACT}`
      ]) {
        const valid = await read(TOKEN, suffix);
        expect(valid.status).toBe(200);
        expect(valid.headers.get('cache-control')).toBe('no-store');
        await valid.arrayBuffer();
      }
      now.mockReturnValue(EXPIRES_AT * 1000);
      for (const suffix of [
        '',
        '/assets/asset_expiring',
        `/sources/${ARTIFACT}`
      ]) {
        const expired = await read(TOKEN, suffix);
        expect(expired.status).toBe(404);
        const body: unknown = await expired.json();
        for (const token of ['u'.repeat(43), 'malformed']) {
          const unavailable = await read(token, suffix);
          expect(unavailable.status).toBe(404);
          expect(await unavailable.json()).toEqual(body);
        }
        db.prepare('UPDATE project_share_links SET revoked_at = ?').run(
          EXPIRES_AT
        );
        now.mockReturnValue((EXPIRES_AT - 1) * 1000);
        const revoked = await read(TOKEN, suffix);
        expect(revoked.status).toBe(404);
        expect(await revoked.json()).toEqual(body);
        db.prepare('UPDATE project_share_links SET revoked_at = NULL').run();
        now.mockReturnValue(EXPIRES_AT * 1000);
      }
    } finally {
      db.close();
    }
  });

  it('mints with server time and ignores client attempts to extend the lifetime', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(CREATED_AT * 1000);
    const env = {
      ENVIRONMENT: 'development' as const,
      AUTH_MODE: 'development' as const,
      PROJECT_SHARING_ENABLED: 'true',
      ARTIFACTS: {} as R2Bucket
    };
    const headers = {
      'x-openzcad-development-user': `user_expiration_${crypto.randomUUID()}`
    };
    const created = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Expiring link' })
      }),
      env
    );
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as CreateProjectResponse;
    const minted = await worker.fetch(
      new Request(
        `https://example.com/api/projects/${document.projectId}/share-links`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            mode: 'tweak',
            createdAt: EXPIRES_AT,
            expiresAt: EXPIRES_AT * 1000
          })
        }
      ),
      env
    );
    expect(minted.status).toBe(201);
    const payload = (await minted.json()) as CreateProjectShareLinkResponse;
    expect(payload.shareLink.createdAt).toBe(CREATED_AT);
    expect(Object.keys(payload.shareLink).sort()).toEqual([
      'createdAt',
      'label',
      'mode',
      'projectId',
      'revokedAt',
      'shareLinkId'
    ]);
    const read = () =>
      worker.fetch(
        new Request(`https://example.com/api/share/${payload.token}`),
        env
      );
    now.mockReturnValue(EXPIRES_AT * 1000 - 1);
    expect((await read()).status).toBe(200);
    now.mockReturnValue(EXPIRES_AT * 1000);
    expect((await read()).status).toBe(404);
  });
});
