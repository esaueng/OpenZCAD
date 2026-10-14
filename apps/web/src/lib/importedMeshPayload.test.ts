import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { parseStl } from '@openzcad/io-stl';
import {
  decodeImportedMeshPayload,
  documentStructureError,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { createInFlightImportChecksums } from './importArchival';
import {
  importedMeshCommand,
  meshInDocumentUnits
} from './importedMeshCommand';
import {
  archiveImportedMesh,
  holdImportedMeshPayload,
  meshImportRunResult,
  type MeshPayloadStore
} from './importedMeshPayload';
import {
  hasSourceBlob,
  loadSourceBlob,
  saveImportedProject,
  saveLocalProject
} from './localProjectStore';
import { createProjectBackup } from './projectBackupTransfer';
import { parseProjectBackup } from './projectBackup';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const user = toUserId('user_mesh_payload');

/** A binary STL of facets on a 0.1 mm grid, like any scanned part. */
function binaryStl(triangles: number): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  for (let i = 0; i < triangles; i += 1) {
    const base = 84 + i * 50 + 12;
    const x = (i % 1000) * 0.1;
    const y = Math.floor(i / 1000) * 0.1;
    [x, y, 0, x + 0.1, y, 0, x, y + 0.1, 0.5].forEach((value, k) =>
      view.setFloat32(base + k * 4, value, true)
    );
  }
  return buffer;
}

function marks() {
  return {
    inFlight: createInFlightImportChecksums(),
    abandoned: new Set<string>()
  };
}

let ids = 0;
const newId = () => `id_${(ids += 1)}`;

describe('holding a mesh import payload', () => {
  const triangles = {
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2]
  };

  it('stores one payload and hands the command a reference', async () => {
    const held = marks();
    const hold = await holdImportedMeshPayload({
      triangles,
      marks: held,
      newId
    });
    expect('meshPayloadRef' in hold.form).toBe(true);
    const ref = (hold.form as { meshPayloadRef: { checksumSha256: string } })
      .meshPayloadRef;
    expect(held.inFlight.has(ref.checksumSha256)).toBe(true);
    const stored = await loadSourceBlob(ref.checksumSha256);
    expect(stored).toEqual(hold.bytes);
    expect(Array.from(decodeImportedMeshPayload(stored!).vertices)).toEqual(
      triangles.vertices
    );

    // A refused import that wrote the bytes takes them away again.
    expect(await hold.settle('refused', null)).toBe(true);
    expect(held.inFlight.has(ref.checksumSha256)).toBe(false);
    expect(await hasSourceBlob(ref.checksumSha256)).toBe(false);
    // Settling twice is a no-op, never a second deletion attempt.
    expect(await hold.settle('refused', null)).toBe(false);
  });

  it('keeps the payload of a committed import', async () => {
    const hold = await holdImportedMeshPayload({
      triangles,
      marks: marks(),
      newId
    });
    const manager = new CommandManager(createProjectDocument('Kept', user));
    manager.execute(
      importedMeshCommand(
        { name: 'tri.stl', triangleCount: 1 },
        hold.form,
        'artifact_local_tri'
      )
    );
    await saveLocalProject(manager.document);
    const ref = (hold.form as { meshPayloadRef: { checksumSha256: string } })
      .meshPayloadRef;
    expect(await hold.settle('committed', manager.document)).toBe(false);
    expect(await hasSourceBlob(ref.checksumSha256)).toBe(true);
  });

  it('embeds the triangles when this browser has no usable blob storage', async () => {
    const store: MeshPayloadStore = {
      ensureLocalProjectStorage: async () => 'unavailable',
      putSourceBlobIfAbsent: () => {
        throw new Error('must not write');
      },
      deleteSourceBlobIfUnreferenced: () => {
        throw new Error('must not delete');
      },
      releaseSourceBlobClaim: async () => undefined
    };
    const hold = await holdImportedMeshPayload({
      triangles,
      marks: marks(),
      newId,
      store
    });
    expect(hold.form).toBe(triangles);
    expect(hold.bytes).toBeNull();
    expect(await hold.settle('refused', null)).toBe(false);
  });

  it('maps a validated run onto what becomes of the bytes', () => {
    expect(meshImportRunResult('committed', false)).toBe('committed');
    expect(meshImportRunResult('committed', true)).toBe('committed');
    expect(meshImportRunResult('failed', true)).toBe('cancelled');
    expect(meshImportRunResult('cancelled', false)).toBe('cancelled');
    expect(meshImportRunResult('busy', false)).toBe('no-verdict');
    expect(meshImportRunResult('superseded', false)).toBe('no-verdict');
    expect(meshImportRunResult('rejected', false)).toBe('refused');
    expect(meshImportRunResult('failed', false)).toBe('refused');
  });
});

describe('archiving a mesh import', () => {
  const original = {
    fileName: 'scan.stl',
    contentType: 'model/stl',
    kind: 'stl-import' as const,
    body: new NodeBlob(['solid']) as unknown as Blob
  };

  it('points a referenced mesh at its uploaded payload, and stores the original beside it', async () => {
    const uploads: string[] = [];
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array([1, 2, 3]) },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => {
        uploads.push(`${input.kind}:${input.fileName}`);
        return `artifact_${input.kind}`;
      },
      newId
    });
    expect(uploads).toEqual([
      'mesh-payload:scan.stl.ozmesh',
      'stl-import:scan.stl'
    ]);
    expect(archived).toEqual({
      artifactId: 'artifact_mesh-payload',
      payloadArchived: true,
      originalArchived: true,
      note: '.'
    });
  });

  it('lands a referenced mesh locally when its payload upload fails', async () => {
    const archived = await archiveImportedMesh({
      hold: { bytes: new Uint8Array([1, 2, 3]) },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => {
        if (input.kind === 'mesh-payload') throw new Error('offline');
        return 'artifact_original';
      },
      newId
    });
    expect(archived.artifactId).toMatch(/^artifact_local_/);
    expect(archived.payloadArchived).toBe(false);
    expect(archived.originalArchived).toBe(true);
    // The status line says what other devices are missing.
    expect(archived.note).toBe(
      ' (cloud archive unavailable; mesh saved locally).'
    );
  });

  it('points an embedded mesh at the original, as before references', async () => {
    const archived = await archiveImportedMesh({
      hold: { bytes: null },
      sourceName: 'scan.stl',
      original,
      archive: async (input) => `artifact_${input.kind}`,
      newId
    });
    expect(archived).toEqual({
      artifactId: 'artifact_stl-import',
      payloadArchived: null,
      originalArchived: true,
      note: '.'
    });
  });

  it('rethrows a cancelled upload instead of landing local-only', async () => {
    const abort = new AbortController();
    await expect(
      archiveImportedMesh({
        hold: { bytes: new Uint8Array([1]) },
        sourceName: 'scan.stl',
        original,
        archive: async () => {
          abort.abort();
          throw new DOMException('stopped', 'AbortError');
        },
        newId,
        signal: abort.signal
      })
    ).rejects.toThrow('stopped');
  });
});

describe(
  'backups of a project holding an imported mesh',
  { timeout: 60_000 },
  () => {
    it('restores the backup it exports for a 25k-triangle STL import', async () => {
      const parsed = parseStl(binaryStl(25_000), 'download.stl');
      const hold = await holdImportedMeshPayload({
        triangles: meshInDocumentUnits(parsed, 'mm'),
        marks: marks(),
        newId
      });
      const manager = new CommandManager(
        createProjectDocument('Mesh backup', user)
      );
      manager.execute(
        importedMeshCommand(parsed, hold.form, 'artifact_local_mesh')
      );
      const document: ProjectDocument = manager.document;
      await saveLocalProject(document);
      await hold.settle('committed', document);
      expect(documentStructureError(document)).toBeNull();

      const exported = await createProjectBackup(document, false);
      // Before references: "Project document holds more than 500000 values."
      const backup = await parseProjectBackup(exported);
      expect(backup.sources).toHaveLength(1);

      // The restored copy carries the payload into a fresh device's blob store,
      // and its triangles are the ones imported.
      globalThis.indexedDB = new IDBFactory();
      await saveImportedProject(backup);
      const ref = (hold.form as { meshPayloadRef: { checksumSha256: string } })
        .meshPayloadRef;
      const restored = await loadSourceBlob(ref.checksumSha256);
      expect(restored).not.toBeNull();
      const decoded = decodeImportedMeshPayload(restored!);
      expect(decoded.vertices.length).toBe(parsed.vertices.length);
      expect(decoded.vertices[12_345]).toBe(parsed.vertices[12_345]);
      expect(Array.from(decoded.indices.subarray(0, 6))).toEqual(
        parsed.indices.slice(0, 6)
      );
    });

    it('refuses a backup whose mesh payload is missing', async () => {
      const hold = await holdImportedMeshPayload({
        triangles: {
          vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2]
        },
        marks: marks(),
        newId
      });
      const manager = new CommandManager(createProjectDocument('Torn', user));
      manager.execute(
        importedMeshCommand(
          { name: 'tri.stl', triangleCount: 1 },
          hold.form,
          'artifact_local_tri'
        )
      );
      await saveLocalProject(manager.document);
      const text = await createProjectBackup(manager.document, false);
      const torn = JSON.parse(text) as { sources: unknown[] };
      torn.sources = [];
      await expect(parseProjectBackup(JSON.stringify(torn))).rejects.toThrow(
        'Missing mesh data: tri.stl'
      );
    });
  }
);
