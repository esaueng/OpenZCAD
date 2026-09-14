import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectDocument, importMeshBody } from '@openzcad/document-core';
import { solidFromTriangles, solidVolume } from '@openzcad/geometry';
import {
  MESH_IMPORT_POLICIES,
  meshImportFormatForFileName,
  meshImportTooLargeMessage,
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
  deflatedThreeMfFixture,
  FIXTURE_BOX,
  FIXTURE_BOX_TRIANGLES,
  FIXTURE_BOX_VOLUME,
  FIXTURE_OBJECT_PITCH,
  meshFixture,
  thinPlateObj,
  THREE_MF_UNIT_MILLIMETRES,
  threeMfFixture
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

interface RebuiltBody {
  readonly warnings: readonly string[];
  readonly volume: number | undefined;
  readonly bbox:
    | {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
      }
    | undefined;
}

/**
 * The triangles through the rebuild the document runs, as a body.
 *
 * The question every import case has to answer is not "did `importMeshFile`
 * return triangles" but "does a feature holding them come back as a body" —
 * the round-1 defect was exactly a success message in front of no body — so
 * the assertions go through `syncDocument`.
 */
async function rebuiltBody(
  adapter: ExactKernelAdapter,
  name: string,
  mesh: { vertices: number[]; indices: number[]; triangleCount: number }
): Promise<RebuiltBody> {
  const imported = importMeshBody(createProjectDocument(name, user), {
    name,
    artifactId: `artifact_${name.replace(/\W+/g, '_')}`,
    sourceName: `${name}.mesh`,
    vertices: mesh.vertices,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount
  });
  const derived = await adapter.syncDocument(imported.document);
  const body = derived.bodyRepresentations[imported.bodyId];
  return {
    warnings: derived.warnings,
    volume: body?.volume,
    bbox: body?.bbox
  };
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
      const mesh = await importMeshFile(format, meshFixture(format), 'mm');

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
      const mesh = await importMeshFile(format, meshFixture(format), 'mm');
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

  // A 3MF is the only one of these formats that states what its numbers mean,
  // and the pinned translator ignores the statement. Reading a file authored
  // in inches at millimetre scale is silent, 25.4x wrong geometry, so these
  // cases pin the conversion and the refusal that guards it.
  describe('a 3MF declared length unit', () => {
    it.each(Object.keys(THREE_MF_UNIT_MILLIMETRES))(
      'converts a box declared in %s to millimetres',
      async (unit) => {
        const factor = THREE_MF_UNIT_MILLIMETRES[unit]!;
        const mesh = await importMeshFile(
          '3mf',
          threeMfFixture({ unit }),
          'mm'
        );

        expect(mesh.sourceUnit).toBe(unit);
        expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES);
        const xs = mesh.vertices.filter((_value, index) => index % 3 === 0);
        expect(Math.max(...xs)).toBeCloseTo(FIXTURE_BOX.x * factor, 9);
        expect(Math.min(...xs)).toBeCloseTo(0, 9);
        expect(meshVolume(mesh)).toBeCloseTo(
          FIXTURE_BOX_VOLUME * factor ** 3,
          6
        );
      }
    );

    it('treats an absent unit as the format default of millimetres', async () => {
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({ unit: null }),
        'mm'
      );

      expect(mesh.sourceUnit).toBe('millimeter');
      expect(meshVolume(mesh)).toBeCloseTo(FIXTURE_BOX_VOLUME, 9);
    });

    it('reads the declaration out of a deflated package too', async () => {
      // Every real exporter deflates its parts; the other fixtures store them.
      const mesh = await importMeshFile(
        '3mf',
        await deflatedThreeMfFixture({ unit: 'inch' }),
        'mm'
      );

      expect(mesh.sourceUnit).toBe('inch');
      expect(meshVolume(mesh)).toBeCloseTo(FIXTURE_BOX_VOLUME * 25.4 ** 3, 3);
    });

    it('refuses a unit the format does not define rather than guessing', async () => {
      await expect(
        importMeshFile('3mf', threeMfFixture({ unit: 'furlong' }), 'mm')
      ).rejects.toThrow(/declares unit "furlong"/);
    });

    it('refuses a package it cannot open, by what stopped it', async () => {
      await expect(
        importMeshFile(
          '3mf',
          new TextEncoder().encode('not a zip at all'),
          'mm'
        )
      ).rejects.toThrow('This 3MF package could not be read: it is not a Zip');
    });

    it('rebuilds an inch-authored box at its real size', async () => {
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({ unit: 'inch' }),
        'mm'
      );
      const imported = importMeshBody(
        createProjectDocument('inch part', user),
        {
          name: 'Imported inches',
          artifactId: 'artifact_inch',
          sourceName: 'box.3mf',
          vertices: mesh.vertices,
          indices: mesh.indices,
          triangleCount: mesh.triangleCount
        }
      );

      const derived = await adapter.syncDocument(imported.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME * 25.4 ** 3, 3);
      expect(body.bbox.max.x).toBeCloseTo(FIXTURE_BOX.x * 25.4, 6);
    });
  });

  /**
   * Several objects in one file, in every format that can hold them.
   *
   * This is the case round 1 got wrong twice. A file of two disjoint boxes
   * used to import behind "Imported 24 triangles" and then rebuild to no body;
   * the first fix answered that by counting the translator's solids and
   * refusing, which never fired for OBJ, GLB or PLY — they return one solid
   * holding several shells — and which refused 3MF files that rebuild
   * perfectly well. Measured on the pin: the two-box soup sews into one valid
   * solid of the summed volume in all four formats. So the contract is that
   * the file imports, and these cases hold it to the body, not to a count.
   */
  it.each(FORMATS)(
    'imports a %s file of two objects as one body of both',
    async (format) => {
      const mesh = await importMeshFile(format, meshFixture(format, 2), 'mm');
      expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES * 2);

      const body = await rebuiltBody(adapter, `two ${format}`, mesh);
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME * 2, 6);
      expect(body.bbox!.min).toEqual({ x: 0, y: 0, z: 0 });
      expect(body.bbox!.max).toEqual({
        x: FIXTURE_OBJECT_PITCH + FIXTURE_BOX.x,
        y: FIXTURE_BOX.y,
        z: FIXTURE_BOX.z
      });
    }
  );

  it('refuses a file whose triangles cannot become a body, naming what stopped it', async () => {
    // A build that places the same object twice at the same spot: the
    // translator reads it, the triangles come out, and the rebuild's sew
    // refuses them as non-manifold. The import has to be the one that says so
    // — the alternative is the original defect, a success line in front of a
    // feature with no body.
    await expect(
      importMeshFile(
        '3mf',
        threeMfFixture({ items: [{ objectid: 1 }, { objectid: 1 }] }),
        'mm'
      )
    ).rejects.toThrow(
      /^This 3MF file could not be imported as a body: .*non-manifold.*Its triangles form 2 groups that share no vertex/s
    );
  });

  it('refuses a mesh with too few triangles to be a body', async () => {
    const oneTriangle = new TextEncoder().encode(
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'
    );
    await expect(importMeshFile('obj', oneTriangle, 'mm')).rejects.toThrow(
      'This OBJ file could not be imported as a body: An imported mesh needs at least two triangles'
    );
  });

  /**
   * What a 3MF's `<build>` section asks for, honoured.
   *
   * The pinned translator reads `<resources>` and ignores `<build>` entirely,
   * so before this every per-item transform was dropped, every repeat of an
   * object imported once, and every object the build never placed imported
   * anyway — all three silently, behind a success message. These cases are the
   * measurements that said so, turned into assertions.
   */
  describe('a 3MF build section', () => {
    it('applies an item transform that scales the object', async () => {
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({
          items: [{ objectid: 1, transform: '2 0 0 0 2 0 0 0 2 0 0 0' }]
        }),
        'mm'
      );

      expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES);
      const body = await rebuiltBody(adapter, 'doubled', mesh);
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME * 8, 6);
      expect(body.bbox!.max).toEqual({
        x: FIXTURE_BOX.x * 2,
        y: FIXTURE_BOX.y * 2,
        z: FIXTURE_BOX.z * 2
      });
    });

    it('applies an item transform that moves the object', async () => {
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({
          items: [{ objectid: 1, transform: '1 0 0 0 1 0 0 0 1 100 0 0' }]
        }),
        'mm'
      );

      const body = await rebuiltBody(adapter, 'moved', mesh);
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME, 6);
      expect(body.bbox!.min.x).toBeCloseTo(100, 6);
      expect(body.bbox!.max.x).toBeCloseTo(100 + FIXTURE_BOX.x, 6);
    });

    it('keeps a mirrored placement facing outwards', async () => {
      // A negative determinant turns every triangle inside out. Without the
      // winding swap the shell encloses a negative volume, which is not the
      // part the file asks for.
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({
          items: [{ objectid: 1, transform: '-1 0 0 0 1 0 0 0 1 0 0 0' }]
        }),
        'mm'
      );

      const body = await rebuiltBody(adapter, 'mirrored', mesh);
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME, 6);
      expect(body.bbox!.min.x).toBeCloseTo(-FIXTURE_BOX.x, 6);
      expect(body.bbox!.max.x).toBeCloseTo(0, 6);
    });

    it('places an object as many times as the build asks', async () => {
      // The ordinary shape of a two-up print plate: one object resource, two
      // items. The translator returns one solid; the file asks for two copies.
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({
          items: [
            { objectid: 1 },
            { objectid: 1, transform: '1 0 0 0 1 0 0 0 1 20 0 0' }
          ]
        }),
        'mm'
      );

      expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES * 2);
      const body = await rebuiltBody(adapter, 'two up', mesh);
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME * 2, 6);
      expect(body.bbox!.max.x).toBeCloseTo(20 + FIXTURE_BOX.x, 6);
    });

    it('imports only what the build places, leaving a spare resource out', async () => {
      // Two object resources, one build item. The file is a single built
      // object; the round-1 guard counted resources and turned it away with
      // advice it had already followed.
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({ objects: 2, items: [{ objectid: 1 }] }),
        'mm'
      );

      expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES);
      const body = await rebuiltBody(adapter, 'spare', mesh);
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(FIXTURE_BOX_VOLUME, 6);
      expect(body.bbox!.max.x).toBeCloseTo(FIXTURE_BOX.x, 6);
    });

    it('reads the build out of a deflated package too', async () => {
      // `<build>` is the last element of the model part, after every vertex
      // and triangle, so reading it means streaming the whole deflated part —
      // a longer path than the 64 KB header the unit alone needed.
      const mesh = await importMeshFile(
        '3mf',
        await deflatedThreeMfFixture({
          items: [{ objectid: 1, transform: '1 0 0 0 1 0 0 0 1 7 0 0' }]
        }),
        'mm'
      );

      const body = await rebuiltBody(adapter, 'deflated build', mesh);
      expect(body.warnings).toEqual([]);
      expect(body.bbox!.min.x).toBeCloseTo(7, 6);
    });

    it('refuses an object composed of other objects, by what is there', async () => {
      // The translator refuses this package too, but as "mesh has no
      // triangles", which names the wrong cause.
      await expect(
        importMeshFile('3mf', threeMfFixture({ componentObject: true }), 'mm')
      ).rejects.toThrow(
        /builds object "2" out of other objects \(<components>\)/
      );
    });

    it('refuses a build that places an object the resources do not define', async () => {
      await expect(
        importMeshFile(
          '3mf',
          threeMfFixture({ items: [{ objectid: 9 }] }),
          'mm'
        )
      ).rejects.toThrow(
        /build places object "9", which its resources do not define/
      );
    });

    it('refuses a package that places nothing at all', async () => {
      await expect(
        importMeshFile('3mf', threeMfFixture({ items: [] }), 'mm')
      ).rejects.toThrow(/<build> section places no objects/);
      await expect(
        importMeshFile('3mf', threeMfFixture({ omitBuild: true }), 'mm')
      ).rejects.toThrow(/has no <build> section/);
    });

    it('refuses a transform it cannot read rather than dropping it', async () => {
      await expect(
        importMeshFile(
          '3mf',
          threeMfFixture({ items: [{ objectid: 1, transform: '1 2 3' }] }),
          'mm'
        )
      ).rejects.toThrow(/not the twelve numbers the format defines/);
      await expect(
        importMeshFile(
          '3mf',
          threeMfFixture({
            items: [{ objectid: 1, transform: '1 0 0 0 1 0 0 0 0 0 0 0' }]
          }),
          'mm'
        )
      ).rejects.toThrow(/collapses it to no volume/);
    });

    it('refuses an item that places an object from another model part', async () => {
      await expect(
        importMeshFile(
          '3mf',
          threeMfFixture({
            items: [{ objectid: 1, path: '/3D/other.model' }]
          }),
          'mm'
        )
      ).rejects.toThrow(/from another model part \("\/3D\/other.model"\)/);
    });
  });

  it.each(FORMATS)(
    'refuses a %s file over its byte limit before reading it',
    async (format) => {
      const policy = MESH_IMPORT_POLICIES[format];
      const oversized = new Uint8Array(policy.maxInputBytes + 1);
      // The fixture's own header, so the refusal cannot be the parser's.
      oversized.set(meshFixture(format), 0);

      await expect(importMeshFile(format, oversized, 'mm')).rejects.toThrow(
        `${policy.label} import is limited to ${Math.round(policy.maxInputBytes / (1024 * 1024))} MB`
      );
    }
  );

  it('tells a barely oversized file apart from the limit it broke', () => {
    // Rounding both figures to whole megabytes made a 33,600,000-byte file
    // read "limited to 32 MB; this file is 32 MB", which is unreadable as a
    // refusal and gives no sense of how far over the line the file is.
    const justOver = meshImportTooLargeMessage('3mf', 33_600_000);
    expect(justOver).toContain('32.04 MB');
    expect(justOver).toContain('33,600,000 bytes');

    const oneByteOver = meshImportTooLargeMessage(
      '3mf',
      MESH_IMPORT_POLICIES['3mf'].maxInputBytes + 1
    );
    expect(oneByteOver).toContain('33,554,433 bytes');
    expect(oneByteOver).not.toContain('(33,554,432 bytes); this file is 32 MB');
  });

  /**
   * The rebuild check runs at the units the document stores, not millimetres.
   *
   * `importMeshSolid` sews at a tolerance derived from the numbers it is
   * handed, and `commitImportedMesh` adopts an imported mesh at
   * `1 / UNIT_TO_MM[units]` — so a check run in millimetres answers a
   * different question from the rebuild whenever the document is not in
   * millimetres. Measured on the pin before the fix: a 0.0002 mm plate passed
   * the millimetre check, was stored at 1/1000, and then collapsed on the
   * rebuild's sew — "Imported 12 triangles" in front of no body, which is the
   * exact failure this check exists to close.
   */
  describe('the import-time rebuild check', () => {
    const THIN_PLATE_MM = 0.0002;
    const THICK_PLATE_MM = 0.0005;
    const METRE_SCALE = 1 / 1000;
    const plateVolume = (thickness: number): number =>
      FIXTURE_BOX.x * FIXTURE_BOX.y * thickness;

    it('passes a plate a millimetre document can hold, and rebuilds it', async () => {
      const mesh = await importMeshFile(
        'obj',
        thinPlateObj(THIN_PLATE_MM),
        'mm'
      );
      expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES);

      const body = await rebuiltBody(adapter, 'thin plate mm', mesh);
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(plateVolume(THIN_PLATE_MM), 9);
    });

    it('refuses the same plate for a metre document, because the rebuild would', async () => {
      // First the measurement the refusal has to match: the very triangles a
      // metre document would store do not come back as a body.
      const millimetres = await importMeshFile(
        'obj',
        thinPlateObj(THIN_PLATE_MM),
        'mm'
      );
      const asStored = await rebuiltBody(adapter, 'thin plate m', {
        ...millimetres,
        vertices: millimetres.vertices.map((value) => value * METRE_SCALE)
      });
      expect(asStored.volume).toBeUndefined();
      expect(asStored.warnings).toEqual([
        expect.stringContaining('Sewing this mesh changed its size')
      ]);

      // So the import must say so while it is still a file, rather than
      // reporting twelve triangles and leaving a feature with no body.
      await expect(
        importMeshFile('obj', thinPlateObj(THIN_PLATE_MM), 'm')
      ).rejects.toThrow(
        /^This OBJ file could not be imported as a body: Sewing this mesh changed its size/
      );
    });

    it('still imports a plate a metre document can hold', async () => {
      // The check must not widen into a refusal of thin plates: the same file
      // 0.0003 mm thicker sews at both scales, and has to import at both.
      const mesh = await importMeshFile(
        'obj',
        thinPlateObj(THICK_PLATE_MM),
        'm'
      );

      // The returned vertices are millimetres whatever the document units
      // are — only the check is scaled — so the commit's own conversion
      // stays the one place the document's units are applied.
      expect(Math.max(...mesh.vertices)).toBeCloseTo(FIXTURE_BOX.y, 12);
      const body = await rebuiltBody(adapter, 'thick plate m', {
        ...mesh,
        vertices: mesh.vertices.map((value) => value * METRE_SCALE)
      });
      expect(body.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(
        plateVolume(THICK_PLATE_MM) * METRE_SCALE ** 3,
        15
      );
    });
  });

  /**
   * A 3MF whose model part never closes a tag is refused, not accumulated.
   *
   * The scan carries whatever trails a chunk's last `>` into the next chunk,
   * and rescans it there. Uncapped, a model part that withholds a `>` makes
   * that carry the whole part and the rescan quadratic: measured before the
   * cap, 4 MB of tag took 221 ms, 8 MB 878 ms and 16 MB 3,442 ms,
   * from Zip packages under 17 KB — and the scan's own 256 MB ceiling was
   * reachable from a file of a few hundred KB, roughly seventeen minutes of a
   * worker that nothing can cancel.
   */
  describe('a 3MF model part that will not close a tag', () => {
    it('reads a long but closed tag, which is a file it must not refuse', async () => {
      const mesh = await importMeshFile(
        '3mf',
        threeMfFixture({ namePadding: 64 * 1024 }),
        'mm'
      );

      expect(mesh.triangleCount).toBe(FIXTURE_BOX_TRIANGLES);
      expect(meshVolume(mesh)).toBeCloseTo(FIXTURE_BOX_VOLUME, 9);
    });

    it('refuses one that runs past the cap, in bounded time', async () => {
      // 32 MB of attribute out of a 33 KB package. Deflated, because a stored
      // one would be refused by the input ceiling rather than by the scan.
      const hostile = await deflatedThreeMfFixture({
        namePadding: 32 * 1024 * 1024
      });
      expect(hostile.byteLength).toBeLessThan(
        MESH_IMPORT_POLICIES['3mf'].maxInputBytes
      );

      const started = performance.now();
      await expect(importMeshFile('3mf', hostile, 'mm')).rejects.toThrow(
        /runs more than \d+ characters without closing an XML tag/
      );
      // The quadratic rescan put this at roughly fourteen seconds before the
      // cap; it is now the cost of the first 256 KB.
      expect(performance.now() - started).toBeLessThan(3_000);
    });
  });

  it('refuses a file that is not the format it claims, by name', async () => {
    await expect(
      importMeshFile('ply', new TextEncoder().encode('not a ply file'), 'mm')
    ).rejects.toThrow(/^PLY import failed: /);
    // A JSON glTF is not a GLB, which is why `.gltf` is not offered at all.
    await expect(
      importMeshFile('glb', new TextEncoder().encode('{"asset":{}}'), 'mm')
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
