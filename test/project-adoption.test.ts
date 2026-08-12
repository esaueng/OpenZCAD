import { describe, expect, it } from 'vitest';
import {
  DocumentTooLargeError,
  InMemoryPersistenceService,
  ProjectAdoptionError,
  assertPersistableDocument
} from '@openzcad/persistence';
import {
  adoptProjectDocument,
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_PERSISTED_DOCUMENT_BYTES,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  persistedDocumentBytes,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  HttpError,
  parseCreateProjectRequest
} from '../apps/web/worker/validation';

const owner = toUserId('user_owner');
const stranger = toUserId('user_stranger');

/** A document as a signed-out device would hold it: local id, local owner. */
function localDocument(name = 'Bracket'): ProjectDocument {
  return createProjectDocument(name, toUserId('user_local'));
}

describe('adoptProjectDocument', () => {
  it('keeps the project id so the device stays pointed at one project', () => {
    const local = localDocument();
    const adopted = adoptProjectDocument(local, owner);
    expect(adopted.projectId).toBe(local.projectId);
  });

  it('transfers ownership and records that the account took it on', () => {
    const adopted = adoptProjectDocument(localDocument(), owner);
    expect(adopted.ownerUserId).toBe(owner);
    expect(adopted.checkpoints.at(-1)?.reason).toBe('Saved to account');
  });

  it('leaves canonical history and version alone', () => {
    const local = localDocument();
    const adopted = adoptProjectDocument(local, owner);
    // The version has to survive: the device's derived geometry describes this
    // version, and a bump would make an identical document look divergent.
    expect(adopted.version).toBe(local.version);
    expect(adopted.commandLog).toEqual(local.commandLog);
    expect(adopted.revisions).toEqual(local.revisions);
  });

  it('renames the project and its root node together', () => {
    const adopted = adoptProjectDocument(localDocument(), owner, 'Renamed');
    expect(adopted.name).toBe('Renamed');
    const root = adopted.nodes[adopted.rootNodeId];
    expect(root?.kind === 'project' && root.name).toBe('Renamed');
  });

  it('normalizes an older document on the way in', () => {
    const legacy = {
      ...localDocument(),
      schemaVersion: 4
    } as unknown as ProjectDocument;
    expect(adoptProjectDocument(legacy, owner).schemaVersion).toBe(
      PROJECT_DOCUMENT_SCHEMA_VERSION
    );
  });

  it('adopts a document with no revision rather than refusing it', () => {
    // Adoption is a rescue path for documents this code has never seen. A
    // checkpoint is impossible without a revision, so it goes without one.
    const orphan = { ...localDocument(), revisions: [] } as ProjectDocument;
    const adopted = adoptProjectDocument(orphan, owner);
    expect(adopted.ownerUserId).toBe(owner);
    expect(adopted.checkpoints.at(-1)?.reason).not.toBe('Saved to account');
  });
});

describe('withoutDerivedProjection', () => {
  it('drops meshes but keeps the conclusions drawn about the document', () => {
    const source: ProjectDocument = {
      ...localDocument(),
      derived: {
        bodyRepresentations: { body_1: { kind: 'mesh' } } as never,
        exportableBodyIds: ['body_1'] as never,
        warnings: ['a warning'],
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    };
    const stripped = withoutDerivedProjection(source);
    expect(stripped.derived.bodyRepresentations).toEqual({});
    expect(stripped.derived.exportableBodyIds).toEqual([]);
    expect(stripped.derived.warnings).toEqual(['a warning']);
    expect(stripped.derived.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('assertPersistableDocument', () => {
  it('accepts an ordinary document', () => {
    expect(() => assertPersistableDocument(localDocument())).not.toThrow();
  });

  it('refuses a document over the ceiling and names both numbers', () => {
    const oversize: ProjectDocument = {
      ...localDocument(),
      derived: {
        bodyRepresentations: {},
        exportableBodyIds: [],
        warnings: ['x'.repeat(MAX_PERSISTED_DOCUMENT_BYTES + 1)],
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    };
    let thrown: unknown;
    try {
      assertPersistableDocument(oversize);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocumentTooLargeError);
    const error = thrown as DocumentTooLargeError;
    expect(error.limitBytes).toBe(MAX_PERSISTED_DOCUMENT_BYTES);
    expect(error.bytes).toBe(persistedDocumentBytes(oversize));
  });
});

describe('adoption through persistence', () => {
  it('round-trips a device-local project into the account', async () => {
    const service = new InMemoryPersistenceService();
    const local = localDocument('Offline Part');

    const created = await service.createProject(owner, {
      name: local.name,
      document: local
    });

    expect(created.document.projectId).toBe(local.projectId);
    expect(created.document.ownerUserId).toBe(owner);
    const loaded = await service.loadProject(owner, local.projectId);
    expect(loaded?.name).toBe('Offline Part');
    const listed = await service.listProjects(owner);
    expect(listed.projects.map((project) => project.projectId)).toContain(
      local.projectId
    );
  });

  it('stores the document without its derived projection', async () => {
    const service = new InMemoryPersistenceService();
    const local: ProjectDocument = {
      ...localDocument(),
      derived: {
        bodyRepresentations: { body_1: { kind: 'mesh' } } as never,
        exportableBodyIds: ['body_1'] as never,
        warnings: [],
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    };
    const created = await service.createProject(owner, {
      name: local.name,
      document: local
    });
    expect(created.document.derived.bodyRepresentations).toEqual({});
    expect(created.document.derived.exportableBodyIds).toEqual([]);
  });

  it('refuses to adopt a project the account already holds', async () => {
    const service = new InMemoryPersistenceService();
    const local = localDocument();
    await service.createProject(owner, { name: local.name, document: local });

    const retry = service.createProject(owner, {
      name: local.name,
      document: local
    });
    await expect(retry).rejects.toThrow(ProjectAdoptionError);
    await expect(retry).rejects.toMatchObject({ code: 'ALREADY_ADOPTED' });
  });

  it('refuses an id that belongs to somebody else, without saying whose', async () => {
    const service = new InMemoryPersistenceService();
    const local = localDocument();
    await service.createProject(owner, { name: local.name, document: local });

    const collision = service.createProject(stranger, {
      name: local.name,
      document: local
    });
    await expect(collision).rejects.toMatchObject({
      code: 'PROJECT_ID_TAKEN'
    });
    await expect(collision).rejects.toThrow(/already in use/);
    // The refusal must not leak the owner it collided with.
    await expect(collision).rejects.not.toThrow(new RegExp(owner));
  });

  it('leaves the original owner in possession after a refused collision', async () => {
    const service = new InMemoryPersistenceService();
    const local = localDocument('Mine');
    await service.createProject(owner, { name: local.name, document: local });
    await service
      .createProject(stranger, { name: 'Theirs', document: local })
      .catch(() => undefined);

    const loaded = await service.loadProject(owner, local.projectId);
    expect(loaded?.name).toBe('Mine');
    expect(loaded?.ownerUserId).toBe(owner);
    await expect(
      service.loadProject(stranger, local.projectId)
    ).resolves.toBeNull();
  });

  it('still mints a fresh project when no document is supplied', async () => {
    const service = new InMemoryPersistenceService();
    const created = await service.createProject(owner, { name: 'Fresh' });
    expect(created.document.ownerUserId).toBe(owner);
    expect(created.document.name).toBe('Fresh');
    expect(created.document.checkpoints.at(-1)?.reason).toBe(
      'Initial document'
    );
  });

  it('accepts a revision against the adopted project immediately', async () => {
    // Adoption is only useful if the project is a normal cloud project
    // afterwards, which means the version it reports has to be the version a
    // save can be fenced against.
    const service = new InMemoryPersistenceService();
    const local = localDocument();
    const created = await service.createProject(owner, {
      name: local.name,
      document: local
    });
    const saved = await service.saveRevision(owner, {
      projectId: created.document.projectId,
      reason: 'Manual save',
      expectedVersion: created.document.version,
      document: created.document
    });
    expect(saved.checkpoints.at(-1)?.reason).toBe('Manual save');
  });
});

describe('create-project request validation', () => {
  it('reads a create without a document as before', () => {
    const request = parseCreateProjectRequest({ name: 'Plain', units: 'mm' });
    expect(request.document).toBeUndefined();
    expect(request.units).toBe('mm');
  });

  it('accepts an adoption payload', () => {
    const local = localDocument();
    const request = parseCreateProjectRequest({
      name: local.name,
      document: local
    });
    expect(request.document?.projectId).toBe(local.projectId);
  });

  it('requires the document to carry a project id of its own', () => {
    const local = { ...localDocument(), projectId: '' };
    expect(() =>
      parseCreateProjectRequest({ name: 'Nameless', document: local })
    ).toThrow(HttpError);
  });

  it('refuses a document from a newer client than this deployment', () => {
    const local = {
      ...localDocument(),
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1
    };
    expect(() =>
      parseCreateProjectRequest({ name: local.name, document: local })
    ).toThrow(/newer than this deployment supports/);
  });

  it('accepts a document from an older client, which normalization migrates', () => {
    const local = { ...localDocument(), schemaVersion: 1 };
    expect(() =>
      parseCreateProjectRequest({ name: local.name, document: local })
    ).not.toThrow();
  });

  it('accepts a cloud document above the former D1 row ceiling', () => {
    const source = localDocument();
    const local: ProjectDocument = {
      ...source,
      derived: {
        ...source.derived,
        warnings: ['x'.repeat(MAX_PERSISTED_DOCUMENT_BYTES + 1)]
      }
    };
    expect(() =>
      parseCreateProjectRequest({ name: local.name, document: local })
    ).not.toThrow();
  });

  it('refuses an oversize document with 413 rather than a generic 400', () => {
    const source = localDocument();
    const local: ProjectDocument = {
      ...source,
      derived: {
        ...source.derived,
        warnings: ['x'.repeat(MAX_CLOUD_PROJECT_DOCUMENT_BYTES + 1)]
      }
    };
    let thrown: unknown;
    try {
      parseCreateProjectRequest({ name: local.name, document: local });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(413);
  });

  it('refuses a document that is not an object', () => {
    expect(() =>
      parseCreateProjectRequest({ name: 'Bad', document: 'nope' })
    ).toThrow(HttpError);
  });

  it('refuses a document missing its collections', () => {
    const { commandLog: _dropped, ...local } = localDocument();
    expect(() =>
      parseCreateProjectRequest({ name: local.name, document: local })
    ).toThrow(/missing required collections/);
  });
});
