import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument,
  type BodyFeatureIds
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

/**
 * #1247 (CAD-007): the 20 x 16 x 12 box with its minimum corner at
 * (-10, -8, -6), written by an independent AP214 producer (OCCT's
 * `BRepPrimAPI_MakeBox` through `STEPControl_Writer`; only the header is
 * normalized). Three of its six ADVANCED_FACEs are written against their
 * plane (`same_sense = .F.`) and import as reversed faces. Remus 2026.1.122
 * refused a 2 mm top-open shell of it as "outside the qualified uniform-L
 * collapse cell" while the native box shelled; the pinned Remus reads a
 * reversed planar wall like any other.
 */
const OCCT_BOX_STEP = readFileSync(
  new URL('./fixtures/step/occt-box-20x16x12.step', import.meta.url),
  'utf8'
);
const SOURCE_VOLUME = 20 * 16 * 12;
/** 3840 mm³ less the 16 x 12 x 10 pocket open through the top. */
const OPEN_SHELL_VOLUME = SOURCE_VOLUME - 16 * 12 * 10;
const VOLUME_RTOL = 1e-9;

function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

describe('#1247 top-open shell of an imported planar box', () => {
  it('writes three faces against their plane, the representation that was refused', () => {
    expect(OCCT_BOX_STEP.match(/ADVANCED_FACE\([^;]*,\.F\.\);/g)).toHaveLength(
      3
    );
    expect(OCCT_BOX_STEP).toContain('SURFACE_CURVE');
  });

  it('shells the imported, re-imported and native boxes alike in the SDK', async () => {
    const kernel = new RemusKernel();
    try {
      const io = await loadRemusTranslators();
      const importOne = (step: Uint8Array | string): number => {
        const solids = kernel.deserializeSolids(
          io.importStep(
            typeof step === 'string' ? new TextEncoder().encode(step) : step
          )
        );
        expect(solids).toHaveLength(1);
        return solids[0]!;
      };
      const native = kernel.makeBox(20, 16, 12);
      kernel.transformSolid(native, translation(-10, -8, -6));
      const imported = importOne(OCCT_BOX_STEP);
      const reimported = importOne(
        io.exportStep(kernel.serializeSolids(Uint32Array.of(native)))
      );
      for (const [label, solid] of [
        ['native', native],
        ['OCCT import', imported],
        ['Remus export re-import', reimported]
      ] as const) {
        expect(kernel.validateSolid(solid), label).toBe(0);
        const bounds = [...kernel.boundingBox(solid)];
        for (const [index, value] of [-10, -8, -6, 10, 8, 6].entries()) {
          expect(bounds[index], label).toBeCloseTo(value, 9);
        }
        const tops = [...kernel.getSolidFaces(solid)].filter(
          (face) => kernel.getFaceNormal(face)[2]! > 1 - 1e-12
        );
        expect(tops, label).toHaveLength(1);
        const open = kernel.shell(solid, 2, Uint32Array.of(tops[0]!));
        expect(kernel.validateSolid(open), label).toBe(0);
        expect(kernel.getSolidShells(open), label).toHaveLength(1);
        expect(
          Math.abs(kernel.volume(open, 0.005) - OPEN_SHELL_VOLUME),
          label
        ).toBeLessThanOrEqual(OPEN_SHELL_VOLUME * VOLUME_RTOL);
      }
    } finally {
      kernel.free();
    }
  });

  it('builds the same valid 1920 mm³ shell through the adapter for the import and the native box', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const shellOf = async (
        label: string,
        source: (manager: CommandManager) => BodyFeatureIds
      ) => {
        const manager = new CommandManager(
          createProjectDocument(label, toUserId('user_test'), 'mm')
        );
        const ids = source(manager);
        const before = await adapter.syncDocument(manager.document);
        expect(before.warnings, label).toEqual([]);
        const body = before.bodyRepresentations[ids.bodyId]!;
        expect(body.volume, label).toBeCloseTo(SOURCE_VOLUME, 6);
        const tops = body.topology!.faces.filter(
          (face) =>
            face.geometry?.normal !== undefined &&
            Math.abs(face.geometry.normal.z - 1) < 1e-9 &&
            Math.abs(face.geometry.center.z - 6) < 1e-9
        );
        expect(tops, label).toHaveLength(1);
        const shell = createBodyFeatureIds();
        manager.execute(
          commandFactories.shellBody({
            name: 'Shell',
            targetBodyId: ids.bodyId,
            openingFaceHashes: [tops[0]!.hash],
            thickness: 2,
            ids: shell
          })
        );
        const after = await adapter.syncDocument(manager.document);
        expect(after.warnings, label).toEqual([]);
        const result = after.bodyRepresentations[shell.bodyId];
        expect(result, label).toBeDefined();
        expect(
          Math.abs(result!.volume - OPEN_SHELL_VOLUME),
          label
        ).toBeLessThanOrEqual(OPEN_SHELL_VOLUME * VOLUME_RTOL);
        const exported = await adapter.exportStep(manager.document, [
          shell.bodyId
        ]);
        const roundtrip = await adapter.inspectStep(exported);
        expect(roundtrip, label).toMatchObject({ solid: true, valid: true });
        expect(roundtrip.volume, label).toBeCloseTo(OPEN_SHELL_VOLUME, 6);
        return result!;
      };

      const imported = await shellOf('Imported box', (manager) => {
        const ids = createBodyFeatureIds();
        manager.execute(
          commandFactories.importStep({
            name: 'Box',
            artifactId: 'artifact_occt_box',
            sourceName: 'occt-box-20x16x12.step',
            stepText: OCCT_BOX_STEP,
            ids
          })
        );
        return ids;
      });
      const native = await shellOf('Native box', (manager) => {
        const ids = createBodyFeatureIds();
        manager.execute(
          commandFactories.addPrimitive({
            name: 'Box',
            primitiveKind: 'box',
            // Kernel axes: width X, height Y, depth Z.
            dimensions: { width: 20, height: 16, depth: 12 },
            ids
          })
        );
        manager.execute(
          commandFactories.transformBody({
            name: 'Seat at the reference corner',
            targetBodyId: ids.bodyId,
            translation: { x: -10, y: -8, z: -6 }
          })
        );
        return ids;
      });
      expect(imported.volume).toBeCloseTo(native.volume, 6);
      expect(imported.topology!.faces).toHaveLength(
        native.topology!.faces.length
      );
    } finally {
      adapter.dispose();
    }
  }, 60_000);
});
