import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  frameForPlaneRef,
  projectEdgeToSketch,
  projectableCurveFromTopology
} from '@openzcad/geometry';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopology,
  type ProjectDocument,
  type SketchObjectData,
  type SketchPlaneRef
} from '@openzcad/shared';
import { failedHistoryExportBodies } from '../apps/web/src/lib/failedHistoryExport';
import {
  omittedExportMessage,
  omittedFailedHistoryBodies,
  staleProjectionExportBodies,
  staleProjectionExportMessage
} from '../apps/web/src/lib/exportOmissions';
import {
  exportScope,
  exportScopeLabel,
  unavailableExportMessage
} from '../apps/web/src/lib/exportScope';

/**
 * #2254 and #2255 against the exact kernel. An all-bodies export must name
 * every body it leaves out or writes from retained geometry:
 *
 * - a new-body Extrude that fails to rebuild leaves no body on screen, so the
 *   failed-history guard had nothing to withhold and the export wrote the
 *   stock alone with a plain "Exported 1 body";
 * - a sketch whose linked projection breaks keeps building from its last
 *   valid geometry, so its Extrude reports no failure and the export wrote
 *   the stale solid with a plain success.
 */
const above: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 8 };
const basis = frameForPlaneRef(above, (value) => Number(value));

/** Top-face (z = 5) edges of the block. */
function topEdges(derived: DerivedState, bodyId: BodyId): EdgeTopology[] {
  const edges = derived.bodyRepresentations[bodyId]?.topology?.edges ?? [];
  return edges.filter((edge) => {
    const n = edge.points.length;
    return Math.abs((edge.points[2]! + edge.points[n - 1]!) / 2 - 5) < 1e-9;
  });
}

function linked(edge: EdgeTopology, bodyId: BodyId): SketchObjectData {
  const outcome = projectEdgeToSketch(
    projectableCurveFromTopology(edge),
    basis
  );
  if (outcome.status !== 'projected') throw new Error(outcome.reason);
  return {
    ...outcome.data,
    projection: {
      mode: 'linked',
      source: { bodyId, edgeReference: edge.reference! }
    }
  };
}

describe(
  'export notes for omitted and stale bodies',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    }, 120_000);
    afterAll(() => adapter.dispose());

    const rebuild = async (document: ProjectDocument) => ({
      ...document,
      derived: await adapter.syncDocument(document)
    });

    /**
     * A sound Stock box, a Block, and a Plate extruded as a new body from the
     * Block's top edges projected (linked) into a sketch above it.
     */
    async function model() {
      let document = addPrimitiveFeature(
        createProjectDocument('Export notes', toUserId('user_export_notes')),
        {
          name: 'Stock',
          primitiveKind: 'box',
          dimensions: { width: 6, height: 6, depth: 6 }
        }
      );
      const stockId = document.bodyOrder.at(-1)!;
      document = addPrimitiveFeature(document, {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 5 }
      });
      const blockId = document.bodyOrder.at(-1)!;
      const edges = topEdges(await adapter.syncDocument(document), blockId);
      expect(edges).toHaveLength(4);
      const sketched = addSketchFeature(document, {
        name: 'Outline',
        planeRef: above,
        objects: edges.map((edge) => linked(edge, blockId))
      });
      const sketch = findSketch(sketched.document, sketched.sketchId)!;
      const extruded = extrudeSketch(sketched.document, {
        name: 'Plate',
        sketchId: sketched.sketchId,
        distance: 3,
        profiles: [{ all: true, sourceEntityIds: [...sketch.objectIds] }]
      });
      const built = await rebuild(extruded.document);
      expect(built.derived.featureWarnings ?? []).toEqual([]);
      expect(staleProjectionExportBodies(built)).toEqual([]);
      expect(omittedFailedHistoryBodies(built)).toEqual([]);
      return { document: built, stockId, blockId, plateId: extruded.bodyId };
    }

    it('names a failed new-body Extrude the export leaves out (#2254)', async () => {
      const { document, stockId, plateId } = await model();
      const plate = listFeaturesInOrder(document).find(
        (feature) => feature.name === 'Plate'
      )!;
      // The profile no longer closes: its saved region names an edge the
      // sketch does not have, so the Extrude builds nothing.
      const broken = structuredClone(document);
      const node = Object.values(broken.nodes).find(
        (entry) =>
          entry.kind === 'feature' && entry.featureId === plate.featureId
      );
      if (node?.kind !== 'feature' || node.data.featureKind !== 'extrude')
        throw new Error('Plate is not an extrude.');
      node.data.profiles = [{ sourceEntityIds: ['missing_edge'] }] as never;
      const failed = await rebuild(broken);
      expect(failed.derived.featureWarnings).toEqual([
        expect.objectContaining({ featureName: 'Plate', kind: 'build-failed' })
      ]);
      expect(failed.derived.bodyRepresentations[plateId]).toBeUndefined();
      // Nothing is on screen to withhold, so the old guard saw nothing.
      expect(failedHistoryExportBodies(failed).size).toBe(0);

      const omitted = omittedFailedHistoryBodies(failed);
      expect(omitted).toEqual([
        expect.objectContaining({ bodyId: plateId, featureName: 'Plate' })
      ]);
      expect(omittedExportMessage(omitted)).toBe(
        'Plate Body not exported: “Plate” failed to rebuild, so it has no geometry to write. Fix or suppress the failed feature in History to export it.'
      );
      // The sound Stock and Block still export, counted against the whole.
      const scope = {
        ...exportScope(
          Object.values(failed.derived.bodyRepresentations).map((body) => ({
            bodyId: body.bodyId,
            exportable: body.exportableStep && !body.consumed,
            hidden: false,
            withheld: false
          })),
          null
        ),
        omittedIds: omitted.map((entry) => entry.bodyId)
      };
      expect(scope.bodyIds).toContain(stockId);
      expect(exportScopeLabel(scope)).toBe('2 of 3 bodies');
      expect(
        unavailableExportMessage(scope, omittedExportMessage(omitted))
      ).toBe('Create a body before exporting.');
    });

    it('names a solid built from a broken linked projection (#2255)', async () => {
      const { document, stockId, plateId } = await model();
      const block = listFeaturesInOrder(document).find(
        (feature) => feature.name === 'Block'
      )!;
      // The projected edges' body is gone: the sketch keeps its last valid
      // outline, and the Plate still builds from it without a failure.
      const stale = await rebuild(
        deleteFeature(document, { featureId: block.featureId })
      );
      expect(
        Object.values(stale.derived.sketchProjections ?? {}).every(
          (state) => state.status === 'broken'
        )
      ).toBe(true);
      expect(
        (stale.derived.featureWarnings ?? []).filter(
          (warning) =>
            warning.kind === 'build-failed' || warning.kind === 'refusal'
        )
      ).toEqual([]);
      expect(stale.derived.bodyRepresentations[plateId]?.volume).toBeCloseTo(
        20 * 10 * 3,
        6
      );

      const bodies = staleProjectionExportBodies(stale);
      expect(bodies).toEqual([
        expect.objectContaining({ bodyId: plateId, sketchName: 'Outline' })
      ]);
      // The unrelated Stock is sound and not named.
      expect(bodies.some((entry) => entry.bodyId === stockId)).toBe(false);
      expect(
        staleProjectionExportMessage(
          bodies,
          (bodyId) => stale.derived.bodyRepresentations[bodyId]!.name
        )
      ).toBe(
        'Plate Body is exported from the last valid geometry of “Outline”, whose linked projection is broken, so it does not follow the edited model. Re-pick or unlink the broken projection to update it.'
      );
    });
  }
);
