import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectDocument, importMeshBody } from '@openzcad/document-core';
import { solidFromTriangles, solidVolume } from '@openzcad/geometry';
import {
  MESH_IMPORT_POLICIES,
  meshImportFormatForFileName,
  type MeshImportFormat
} from '@openzcad/kernel-adapter/mesh-import-formats';
import {
  createExactKernelAdapter,
  importMeshFile,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { InMemoryPersistenceService } from '@openzcad/persistence';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

import {
  FIXTURE_BOX,
  FIXTURE_BOX_TRIANGLES,
  FIXTURE_BOX_VOLUME,
  meshFixture
} from './support/mesh-import-fixtures';

/**
 * Mesh imports beside STL: 3MF, OBJ, glTF binary and PLY.
 *
 * The kernel's translators read all four, so the question these tests answer
 * is not whether the kernel can parse them but whether ZCAD turns what it
 * hands back into the same `imported-mesh` feature an STL import produces —
 * one that survives a save and a reload, and rebuilds into the same body.
 *
 * They also pin the refusals, because an import that crashes the tab on a
 * large file is the failure mode these budgets exist to prevent.
 */

const user = toUserId('user_mesh_formats');
const FORMATS: MeshImportFormat[] = ['3mf', 'obj', 'glb', 'ply'];

function meshVolume(mesh: { vertices: number[]; indices: number[] }): number {
  return Math.abs(solidVolume(solidFromTriangles(mesh.vertices, mesh.indices)));
}

// Real-kernel suite: WASM startup plus the translator module runs well past
// the 5 s default when the whole test pool is contending for CPU.
describe('mesh file imports', { timeout: 30_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it.each(FORMATS)(
    'reads a %s box into the triangles an imported mesh stores',
    async (format) => {
      const mesh = await importMeshFile(format, meshFixture(format));

      expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES);
      expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
      expect(mesh.vertices.length % 3).toBe(0);
      expect(mesh.vertices.every(Number.isFinite)).toBe(true);
      expect(
        mesh.indices.every(
          (index) => index >= 0 && index < mesh.vertices.length / 3
        )
      ).toBe(true);
      // The file's own coordinates, adopted unscaled: the box is still
      // 2 x 3 x 4 and still encloses 24 mm³.
      expect(meshVolume(mesh)).toBeCloseTo(FIXTURE_BOX_VOLUME, 9);
    }
  );

  it.each(FORMATS)(
    'rebuilds a %s import as a body that survives a save and a reload',
    async (format) => {
      const mesh = await importMeshFile(format, meshFixture(format));
      const imported = importMeshBody(
        createProjectDocument(`${format} part`, user),
        {
          name: `Imported ${format}`,
          artifactId: `artifact_${format}`,
          sourceName: `box.${format}`,
          vertices: mesh.vertices,
          indices: mesh.indices,
          triangleCount: mesh.triangleCount
        }
      );

      const service = new InMemoryPersistenceService();
      const created = await service.createProject(user, {
        name: `${format} round trip`
      });
      // Through the wire form as well as the store: a document reaches a
      // reload as JSON, and a mesh that cannot survive that is not persisted.
      const wire = JSON.parse(
        JSON.stringify({
          ...imported.document,
          projectId: created.document.projectId,
          version: created.document.version
        })
      ) as ProjectDocument;
      await service.saveRevision(user, {
        projectId: created.document.projectId,
        reason: `Import ${format}`,
        expectedVersion: created.document.version,
        document: wire
      });
      const reloaded = await service.loadProject(
        user,
        created.document.projectId
      );
      expect(reloaded).not.toBeNull();

      const derived = await adapter.syncDocument(reloaded!);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME, 6);
      expect(body.bbox.min).toEqual({ x: 0, y: 0, z: 0 });
      expect(body.bbox.max).toEqual({
        x: FIXTURE_BOX.x,
        y: FIXTURE_BOX.y,
        z: FIXTURE_BOX.z
      });
    }
  );

  it.each(FORMATS)(
    'refuses a %s file over its byte limit before reading it',
    async (format) => {
      const policy = MESH_IMPORT_POLICIES[format];
      const oversized = new Uint8Array(policy.maxInputBytes + 1);
      // The fixture's own header, so the refusal cannot be the parser's.
      oversized.set(meshFixture(format), 0);

      await expect(importMeshFile(format, oversized)).rejects.toThrow(
        `${policy.label} import is limited to ${Math.round(policy.maxInputBytes / (1024 * 1024))} MB`
      );
    }
  );

  it('refuses a file that is not the format it claims, by name', async () => {
    await expect(
      importMeshFile('ply', new TextEncoder().encode('not a ply file'))
    ).rejects.toThrow(/^PLY import failed: /);
    // A JSON glTF is not a GLB, which is why `.gltf` is not offered at all.
    await expect(
      importMeshFile('glb', new TextEncoder().encode('{"asset":{}}'))
    ).rejects.toThrow(/glTF binary import failed: .*GLB/);
  });

  it('claims exactly the extensions the importers can read', () => {
    expect(meshImportFormatForFileName('part.3mf')).toBe('3mf');
    expect(meshImportFormatForFileName('PART.OBJ')).toBe('obj');
    expect(meshImportFormatForFileName('part.glb')).toBe('glb');
    expect(meshImportFormatForFileName('part.ply')).toBe('ply');
    // STEP and STL have their own paths, and a JSON glTF has none.
    expect(meshImportFormatForFileName('part.stl')).toBeNull();
    expect(meshImportFormatForFileName('part.step')).toBeNull();
    expect(meshImportFormatForFileName('part.gltf')).toBeNull();
  });
});

/**
 * The mesh import path must stay behind the gesture that needs it.
 *
 * `pnpm build`'s size check refuses any anonymous `src-*` chunk the launcher
 * HTML references, and that is what re-exporting the format table from the
 * adapter's index barrel produced: the barrel is in the eager graph, the lazy
 * mesh import client imported the same barrel, and rolldown answered the
 * overlap by hoisting 96 kB of first-paint kernel-adapter source into a shared
 * chunk `index.html` then preloaded. The table has its own package entry point
 * for that reason, and these cases keep it that way — a source shape, because
 * the failure is a source shape.
 */
describe('the mesh import lazy boundary', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = (path: string): string =>
    readFileSync(join(root, path), 'utf8');

  it('keeps the format table out of the adapter index barrel', () => {
    expect(read('packages/kernel-adapter/src/index.ts')).not.toContain(
      'mesh-import-formats'
    );
  });

  it.each([
    'apps/web/src/lib/meshImportWorkerClient.ts',
    'apps/web/src/worker/meshImportWorker.ts'
  ])('reaches the table through its own entry point in %s', (path) => {
    const source = read(path);
    expect(source).toContain("'@openzcad/kernel-adapter/mesh-import-formats'");
    expect(source).not.toMatch(/from '@openzcad\/kernel-adapter'/);
  });

  it('declares that entry point everywhere resolution happens', () => {
    const manifest = JSON.parse(
      read('packages/kernel-adapter/package.json')
    ) as { exports: Record<string, string> };
    expect(manifest.exports['./mesh-import-formats']).toBe(
      './src/mesh-import-formats.ts'
    );
    // The bundler and the type checker resolve it through their own maps; a
    // subpath that exists in only one of them breaks the other.
    expect(read('apps/web/vite.config.ts')).toContain(
      "'@openzcad/kernel-adapter/mesh-import-formats'"
    );
    const tsconfig = JSON.parse(read('tsconfig.base.json')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(
      tsconfig.compilerOptions.paths[
        '@openzcad/kernel-adapter/mesh-import-formats'
      ]
    ).toEqual(['./packages/kernel-adapter/src/mesh-import-formats.ts']);
  });
});
