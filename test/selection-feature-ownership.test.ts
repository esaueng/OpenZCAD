import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { updateFeature, transformBody } from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  type FaceTopology,
  type ProjectDocument,
  type TopologySelection
} from '@openzcad/shared';
import {
  selectionFeature,
  selectionSetFeature
} from '../apps/web/src/lib/selectionFeature';
import { twoFilletCylinder } from './fixtures/two-fillet-cylinder';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';

describe('selected topology edit ownership', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it.each([4, 3])(
    'keeps both fillet owners with bottom radius %s, including after an edit',
    async (bottomRadius) => {
      const { document, top, bottom, bodyId } = await twoFilletCylinder(
        adapter,
        bottomRadius
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      const bands = body.topology!.faces.filter(
        (face) => face.geometry?.featureType === 'blend'
      );
      expect(bands).toHaveLength(2);
      for (const face of body.topology!.faces.filter(
        (entry) => entry.geometry?.featureType !== 'blend'
      )) {
        expect(
          selectionFeature(document, body, {
            bodyId,
            kind: 'face',
            topologyId: face.topologyId,
            hash: face.hash,
            reference: face.reference
          })?.featureId
        ).toBe(document.featureOrder[0]);
      }
      const select = (face: FaceTopology): TopologySelection => ({
        bodyId,
        kind: 'face',
        topologyId: face.topologyId,
        hash: face.hash,
        reference: face.reference
      });
      for (const owner of [top, bottom]) {
        const face = bands.find(
          (candidate) =>
            candidate.reference?.producingFeatureId === owner.featureId
        );
        expect(face).toBeDefined();
        expect(selectionFeature(document, body, select(face!))?.featureId).toBe(
          owner.featureId
        );
        const edges = body.topology!.edges.filter((edge) =>
          edge.adjacentFaceHashes?.includes(face!.hash)
        );
        expect(edges.length).toBeGreaterThan(0);
        for (const edge of edges.filter(
          (candidate) => candidate.displayRole !== 'seam'
        )) {
          expect(
            selectionFeature(document, body, {
              bodyId,
              kind: 'edge',
              hash: edge.hash,
              topologyId: edge.topologyId
            })?.featureId
          ).toBe(owner.featureId);
        }
      }
      expect(
        selectionSetFeature(
          document,
          derived.bodyRepresentations,
          bands.map(select)
        )
      ).toBeNull();
      const picked = select(
        bands.find(
          (face) => face.reference?.producingFeatureId === top.featureId
        )!
      );
      const changed = updateFeature(document, {
        featureId: top.featureId,
        data: { radius: 2 }
      });
      const rebuilt = await adapter.syncDocument(changed);
      expect(rebuilt.warnings).toEqual([]);
      const finalBody = rebuilt.bodyRepresentations[bodyId]!;
      expect(
        finalBody
          .topology!.faces.filter(
            (face) => face.geometry?.featureType === 'blend'
          )
          .map((face) => face.geometry!.blendRadius)
          .sort()
      ).toEqual([2, bottomRadius]);
      expect(selectionFeature(changed, finalBody, picked)?.featureId).toBe(
        top.featureId
      );
      expect(
        isClosedConsistentlyOrientedMesh(
          inspectTriangleMeshClosure(
            finalBody.mesh.vertices,
            finalBody.mesh.indices
          )
        )
      ).toBe(true);
      expect(finalBody.volume).toBeGreaterThan(body.volume);
    }
  );

  it('retains fillet ownership after rigid transforms and document reopen', async () => {
    const { document, top, bodyId } = await twoFilletCylinder(adapter);
    const moved = transformBody(document, {
      name: 'Move',
      targetBodyId: bodyId,
      translation: { x: 10, y: 20, z: 30 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;
    const reopened = JSON.parse(JSON.stringify(moved)) as ProjectDocument;
    const derived = await adapter.syncDocument(reopened);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId]!;
    const face = body.topology!.faces.find(
      (entry) =>
        entry.reference?.producingFeatureId === top.featureId &&
        entry.geometry?.featureType === 'blend'
    );
    expect(face).toBeDefined();
    expect(
      selectionFeature(reopened, body, {
        bodyId,
        kind: 'face',
        reference: face!.reference
      })?.featureId
    ).toBe(top.featureId);
  });

  it('does not guess ownership for stale, missing, duplicate, or suppressed references', async () => {
    const { document, top, bodyId } = await twoFilletCylinder(adapter);
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[bodyId]!;
    const face = body.topology!.faces.find(
      (entry) =>
        entry.reference?.producingFeatureId === top.featureId &&
        entry.geometry?.featureType === 'blend'
    )!;
    const pick: TopologySelection = {
      bodyId,
      kind: 'face',
      topologyId: face.topologyId,
      hash: face.hash,
      reference: face.reference
    };
    expect(
      selectionFeature(document, body, {
        ...pick,
        reference: { ...face.reference!, lineageName: 'missing' }
      })
    ).toBeNull();
    expect(selectionFeature(document, undefined, pick)).toBeNull();
    const duplicate = structuredClone(body);
    duplicate.topology!.faces.push({
      ...face,
      topologyId: 'duplicate',
      hash: face.hash + 1
    });
    expect(selectionFeature(document, duplicate, pick)).toBeNull();
    const unknown = structuredClone(body);
    unknown.topology!.faces.find(
      (entry) => entry.topologyId === face.topologyId
    )!.reference = undefined;
    expect(
      selectionFeature(document, unknown, { ...pick, reference: undefined })
    ).toBeNull();
    const suppressed = structuredClone(document);
    suppressed.nodes[top.id] = {
      ...top,
      metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
    };
    expect(selectionFeature(suppressed, body, pick)).toBeNull();
    expect(
      selectionFeature(document, body, { bodyId, kind: 'body' })?.featureId
    ).toBe(document.featureOrder.at(-1));
  });
});
