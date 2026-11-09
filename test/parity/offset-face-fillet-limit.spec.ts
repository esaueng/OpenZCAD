/**
 * A face offset that would collapse a neighbouring face refuses as a typed
 * limit, not as an internal kernel failure.
 *
 * The body: a 27 × 24 × 16 block whose two right-hand vertical edges are
 * rounded at r8.8, so the Right face keeps a flat only 24 − 2 × 8.8 = 6.4
 * wide, with smaller rounds elsewhere as separate operations. Pushing the
 * Front face in shortens that flat; at 6.4 it is gone. Remus refuses that move
 * correctly, but as prose under `operation_failed` / `internal`, which the
 * app showed as "the exact kernel failed internally". The adapter now raises
 * it as `invalid_topology` with the limit the kernel named.
 *
 * The limit is checked both ways: the value just inside it builds, through
 * both the drag preview (prepared move) and the full rebuild a commit uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

const X = 27;
const Y = 24;
const Z = 16;
const ROUND = 8.8;
/** The Right face's flat between its two r8.8 rounds. */
const FLAT = Y - 2 * ROUND;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** The block, filleted one operation at a time as a user would. */
function filletedBlock(kernel: RemusKernel): number {
  const lineEdges = (
    solid: number,
    keep: (a: number[], b: number[]) => boolean
  ) =>
    Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
      const v = kernel.getEdgeVertices(edge);
      return keep([v[0]!, v[1]!, v[2]!], [v[3]!, v[4]!, v[5]!]);
    });
  const fillet = (solid: number, edges: number[], radius: number) => {
    expect(edges.length).toBeGreaterThan(0);
    const result = kernel.filletDetailed(
      solid,
      Uint32Array.from(edges),
      radius,
      true
    );
    if (result.status !== 'ok') {
      throw new Error(JSON.stringify(result));
    }
    return result.value;
  };
  let solid = kernel.makeBox(X, Y, Z);
  // Front-right and back-right vertical edges.
  solid = fillet(
    solid,
    lineEdges(
      solid,
      (a, b) =>
        near(a[0]!, X) &&
        near(b[0]!, X) &&
        ((near(a[1]!, 0) && near(b[1]!, 0)) ||
          (near(a[1]!, Y) && near(b[1]!, Y)))
    ),
    ROUND
  );
  // Every top edge except the left one.
  solid = fillet(
    solid,
    lineEdges(
      solid,
      (a, b) =>
        near(a[2]!, Z) && near(b[2]!, Z) && !(near(a[0]!, 0) && near(b[0]!, 0))
    ),
    3
  );
  // Left-front vertical edge.
  solid = fillet(
    solid,
    lineEdges(
      solid,
      (a, b) =>
        near(a[0]!, 0) && near(b[0]!, 0) && near(a[1]!, 0) && near(b[1]!, 0)
    ),
    1
  );
  // Bottom-front edge.
  solid = fillet(
    solid,
    lineEdges(
      solid,
      (a, b) =>
        near(a[1]!, 0) && near(b[1]!, 0) && near(a[2]!, 0) && near(b[2]!, 0)
    ),
    1
  );
  return solid;
}

describe(
  'offset face against a filleted neighbour',
  { timeout: 120_000 },
  () => {
    let adapter: RemusKernelAdapter;
    let document: ProjectDocument;
    let bodyId: BodyId;
    let front: FaceTopology;

    beforeAll(async () => {
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      const step = new TextDecoder().decode(
        io.exportStep(
          kernel.serializeSolids(Uint32Array.of(filletedBlock(kernel)))
        )
      );
      const imported = importStepBody(
        createProjectDocument('Offset limit', toUserId('user_offset_limit')),
        {
          name: 'Block',
          sourceName: 'offset-limit.step',
          artifactId: 'artifact_offset_limit',
          stepText: step
        }
      );
      document = imported.document;
      bodyId = imported.bodyId;
      adapter = new RemusKernelAdapter();
      const derived = await adapter.syncDocument(document);
      const faces = derived.bodyRepresentations[bodyId]!.topology!.faces;
      front = faces
        .filter(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            face.geometry.normal!.y < -0.999
        )
        .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
      expect(front.geometry!.area).toBeCloseTo(206.4, 3);
    });

    afterAll(() => {
      adapter.dispose();
    });

    function offsetBy(offset: number): ProjectDocument {
      return commandFactories
        .directEditBody({
          name: 'Offset Face',
          targetBodyId: bodyId,
          operation: {
            kind: 'offset-face',
            faceHash: front.hash,
            ...(front.reference ? { faceReference: front.reference } : {}),
            sourceSurfaceType: 'plane',
            sourceArea: front.geometry!.area,
            sourceCenter: front.geometry!.center,
            sourceNormal: front.geometry!.normal!,
            offset
          }
        })
        .apply(document);
    }

    function refusalOf(warnings: readonly FeatureWarning[] | undefined) {
      const refusal = (warnings ?? []).find(
        (warning) =>
          warning.featureName === 'Offset Face' &&
          (warning.kind === 'build-failed' || warning.kind === 'refusal')
      );
      expect(refusal, 'the offset is refused').toBeDefined();
      return refusal!;
    }

    for (const offset of [-6.38, -6.39]) {
      it(`builds ${offset} through the drag preview and the commit rebuild`, async () => {
        const candidate = offsetBy(offset);
        const preview = await adapter.previewGeometry(candidate, {
          deferTopology: true
        });
        expect(preview.warnings).toEqual([]);
        expect(preview.bodyRepresentations[bodyId]).toBeDefined();
        const committed = await adapter.syncDocument(candidate);
        expect(committed.warnings).toEqual([]);
        expect(committed.bodyRepresentations[bodyId]?.volume).toBeGreaterThan(
          0
        );
      });
    }

    for (const offset of [-FLAT, -9]) {
      it(`refuses ${offset} as invalid topology with the limit ${-FLAT}`, async () => {
        const candidate = offsetBy(offset);
        for (const derived of [
          await adapter.previewGeometry(candidate, { deferTopology: true }),
          await adapter.syncDocument(candidate)
        ]) {
          const refusal = refusalOf(derived.featureWarnings);
          expect(refusal.kernelRefusal).toMatchObject({
            family: 'direct-edit',
            operation: 'offset-face',
            category: 'invalid_topology',
            code: 'offset_face_collapses_neighbor'
          });
          expect(refusal.kernelRefusal!.limit).toBeCloseTo(-FLAT, 6);
          // The headline names the limit; the kernel's words stay behind it.
          expect(refusal.message).toContain(
            'A neighbouring face would shrink to nothing past 6.4.'
          );
          expect(refusal.message).toContain('move-face would change topology');
        }
      });
    }

    it('leaves an outward pull alone', async () => {
      const derived = await adapter.previewGeometry(offsetBy(2), {
        deferTopology: true
      });
      expect(derived.warnings).toEqual([]);
    });
  }
);
