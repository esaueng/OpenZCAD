/**
 * Focused exact-edit guard proving Remus preserves the historical BrepKit
 * f7ebc24 WASM refresh behavior.
 *
 * The upstream change tightened NURBS validation, but a committed WASM refresh
 * can move any exact operation. Keep the highest-risk editor contracts beside
 * the parity corpus: analytic direct edits agree with the OCCT reference, and
 * rejected face offsets preserve the last exact body instead of committing a
 * void or a faceted fallback.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  transformBody
} from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { OcctStepKernelAdapter } from './occt-reference/occt-step';

interface SafetyAdapter {
  readonly kind: 'remus' | 'occt';
  syncDocument(document: ProjectDocument): Promise<DerivedState>;
  exportStep(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
  }>;
  dispose(): void;
}

const USER = toUserId('user_direct_edit_parity');

function bodyOf(derived: DerivedState, bodyId: BodyId): BodyRepresentation {
  const body = derived.bodyRepresentations[bodyId];
  expect(body).toBeDefined();
  return body!;
}

function surfaceTypes(body: BodyRepresentation): string[] {
  return (body.topology?.faces ?? [])
    .map((face) => face.geometry?.surfaceType ?? 'unknown')
    .sort();
}

function requireFace(
  body: BodyRepresentation,
  predicate: (face: FaceTopology) => boolean,
  description: string
): FaceTopology {
  const matches = (body.topology?.faces ?? []).filter(predicate);
  expect(matches, description).toHaveLength(1);
  return matches[0]!;
}

async function expectValidRoundTrip(
  adapter: SafetyAdapter,
  document: ProjectDocument,
  bodyId: BodyId,
  expectedVolume: number
): Promise<void> {
  const step = await adapter.exportStep(document, [bodyId]);
  const inspected = await adapter.inspectStep(step);
  expect(inspected).toMatchObject({ solid: true, valid: true });
  expect(inspected.volume).toBeCloseTo(expectedVolume, 4);
}

describe(
  'Remus compatibility with the historical BrepKit f7ebc24 safety fixes',
  { timeout: 30_000 },
  () => {
    let remus: RemusKernelAdapter;
    let occt: OcctStepKernelAdapter;

    beforeAll(async () => {
      remus = new RemusKernelAdapter();
      occt = await OcctStepKernelAdapter.create();
    });

    afterAll(() => {
      remus.dispose();
      occt.dispose();
    });

    it('keeps a radius edit plus cap offset analytic and in parity', async () => {
      const base = addPrimitiveFeature(
        createProjectDocument('Direct-edit parity', USER),
        {
          name: 'Post',
          primitiveKind: 'cylinder',
          dimensions: { radius: 8, height: 18 }
        }
      );
      const bodyId = base.bodyOrder.at(-1)!;
      const expectedVolume = Math.PI * 11 ** 2 * 22;
      const results = new Map<string, BodyRepresentation>();
      for (const adapter of [remus, occt] satisfies SafetyAdapter[]) {
        const source = bodyOf(await adapter.syncDocument(base), bodyId);
        const wall = requireFace(
          source,
          (face) => face.geometry?.surfaceType === 'cylinder',
          `${adapter.kind}: one analytic source wall`
        );
        const resized = directEditBody(base, {
          name: 'Grow post',
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-cylindrical-face',
            faceHash: wall.hash,
            faceReference: wall.reference,
            sourceRadius: wall.geometry!.radius!,
            sourceAxisStart: wall.geometry!.axisStart!,
            sourceAxisEnd: wall.geometry!.axisEnd!,
            concavity: 'boss',
            radius: 11
          }
        }).document;
        const grown = bodyOf(await adapter.syncDocument(resized), bodyId);
        const top = requireFace(
          grown,
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            (face.geometry.normal?.z ?? 0) > 0.99,
          `${adapter.kind}: one outward top cap after the radius edit`
        );
        const edited = directEditBody(resized, {
          name: 'Raise cap',
          targetBodyId: bodyId,
          operation: {
            kind: 'offset-face',
            faceHash: top.hash,
            faceReference: top.reference,
            sourceSurfaceType: 'plane',
            sourceArea: top.geometry!.area,
            sourceCenter: top.geometry!.center,
            sourceNormal: top.geometry!.normal!,
            offset: 4
          }
        }).document;
        const derived = await adapter.syncDocument(edited);
        expect(derived.warnings, adapter.kind).toEqual([]);
        const body = bodyOf(derived, bodyId);
        results.set(adapter.kind, body);
        expect(body.volume, adapter.kind).toBeCloseTo(expectedVolume, 4);
        expect(body.faceCount, adapter.kind).toBe(3);
        expect(surfaceTypes(body), adapter.kind).toEqual([
          'cylinder',
          'plane',
          'plane'
        ]);
        const editedWall = requireFace(
          body,
          (face) => face.geometry?.surfaceType === 'cylinder',
          `${adapter.kind}: one analytic edited wall`
        );
        expect(editedWall.geometry!.radius, adapter.kind).toBeCloseTo(11, 6);
        expect(editedWall.geometry!.axialLength, adapter.kind).toBeCloseTo(
          22,
          6
        );
        await expectValidRoundTrip(adapter, edited, bodyId, expectedVolume);
      }

      expect(results.get('remus')!.volume).toBeCloseTo(
        results.get('occt')!.volume,
        6
      );
    });

    it('fails closed when a face offset would remove the solid', async () => {
      const base = addPrimitiveFeature(
        createProjectDocument('Overcut parity', USER),
        {
          name: 'Beam',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 20, depth: 30 }
        }
      );
      const bodyId = base.bodyOrder.at(-1)!;
      for (const adapter of [remus, occt] satisfies SafetyAdapter[]) {
        const source = bodyOf(await adapter.syncDocument(base), bodyId);
        const top = requireFace(
          source,
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            (face.geometry.normal?.z ?? 0) > 0.99,
          `${adapter.kind}: one outward top face`
        );
        const overcut = directEditBody(base, {
          name: 'Sink past floor',
          targetBodyId: bodyId,
          operation: {
            kind: 'offset-face',
            faceHash: top.hash,
            faceReference: top.reference,
            sourceSurfaceType: 'plane',
            sourceArea: top.geometry!.area,
            sourceCenter: top.geometry!.center,
            sourceNormal: top.geometry!.normal!,
            offset: -40
          }
        }).document;
        const derived = await adapter.syncDocument(overcut);
        expect(derived.warnings, adapter.kind).toHaveLength(1);
        expect(derived.warnings[0], adapter.kind).toMatch(
          /empty result|does not produce a valid solid/
        );
        const preserved = bodyOf(derived, bodyId);
        expect(preserved.volume, adapter.kind).toBeCloseTo(6000, 4);
        expect(preserved.faceCount, adapter.kind).toBe(6);
        expect(surfaceTypes(preserved), adapter.kind).toEqual([
          'plane',
          'plane',
          'plane',
          'plane',
          'plane',
          'plane'
        ]);
        await expectValidRoundTrip(adapter, overcut, bodyId, 6000);
      }
    });

    it('keeps a blind-bore body exact when face offset returns facets', async () => {
      const withOuter = addPrimitiveFeature(
        createProjectDocument('Faceted offset guard', USER),
        {
          name: 'Outer cylinder',
          primitiveKind: 'cylinder',
          dimensions: { radius: 20, height: 50 }
        }
      );
      const outerId = withOuter.bodyOrder.at(-1)!;
      const withDrill = addPrimitiveFeature(withOuter, {
        name: 'Blind bore tool',
        primitiveKind: 'cylinder',
        dimensions: { radius: 10, height: 30 }
      });
      const drillId = withDrill.bodyOrder.at(-1)!;
      const positioned = transformBody(withDrill, {
        name: 'Seat bore above its floor',
        targetBodyId: drillId,
        translation: { x: 0, y: 0, z: 20 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }).document;
      const manager = new CommandManager(positioned);
      const bored = manager.execute(
        commandFactories.booleanBodies({
          name: 'Blind bored cylinder',
          operation: 'subtract',
          targetBodyIds: [outerId, drillId]
        })
      );
      const bodyId = bored.bodyOrder.at(-1)!;
      const beforeState = await remus.syncDocument(bored);
      expect(beforeState.warnings).toEqual([]);
      const before = bodyOf(beforeState, bodyId);
      expect(before.faceCount).toBe(5);
      expect(surfaceTypes(before)).toEqual([
        'cylinder',
        'cylinder',
        'plane',
        'plane',
        'plane'
      ]);
      const boreFloor = requireFace(
        before,
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          Math.abs((face.geometry.center.z ?? 0) - 20) < 1e-5,
        'one blind-bore floor'
      );
      const edited = directEditBody(bored, {
        name: 'Deepen blind bore',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: boreFloor.hash,
          faceReference: boreFloor.reference,
          sourceSurfaceType: 'plane',
          sourceArea: boreFloor.geometry!.area,
          sourceCenter: boreFloor.geometry!.center,
          sourceNormal: boreFloor.geometry!.normal!,
          offset: -5
        }
      }).document;

      const pushPull = vi
        .spyOn(RemusKernel.prototype, 'pushPullFace')
        .mockImplementation(function (
          this: RemusKernel,
          _solid: number,
          _face: number,
          _distance: number
        ) {
          return this.makeBox(40, 40, 50);
        });
      let after: DerivedState;
      let exported: string;
      try {
        after = await remus.syncDocument(edited);
        exported = await remus.exportStep(edited, [bodyId]);
      } finally {
        pushPull.mockRestore();
      }

      expect(after.warnings).toContain(
        'Feature "Deepen blind bore": Offset face refused: the kernel returned a faceted approximation instead of exact surfaces: 5 source faces (2 curved) became 6 result faces (0 curved). The original body was left unchanged.'
      );
      const preserved = bodyOf(after, bodyId);
      expect(preserved.volume).toBeCloseTo(before.volume, 6);
      expect(preserved.faceCount).toBe(before.faceCount);
      expect(surfaceTypes(preserved)).toEqual(surfaceTypes(before));
      const inspected = await remus.inspectStep(exported);
      expect(inspected).toMatchObject({ solid: true, valid: true });
      expect(inspected.volume).toBeCloseTo(before.volume, 4);
    });
  }
);
