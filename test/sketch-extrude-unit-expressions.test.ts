import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getLatestBodyId,
  getLatestSketchId,
  listFeaturesInOrder,
  normalizeDocument,
  resolveParamValue,
  updateFeature
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';

const user = toUserId('user_sketch_extrude_units');
const rectangle = (): SketchObjectData => ({
  objectKind: 'rectangle',
  width: '5 mm + 2 cm',
  height: '1 cm',
  centerX: 0,
  centerY: 0
});

/** F05: the selected-region and legacy whole-object paths must agree. */
function fixture(
  units: UnitSystem,
  object: SketchObjectData = rectangle(),
  selectedRegion = false
): ProjectDocument {
  const sketched = addSketchFeature(
    createProjectDocument(`Sketch/extrude ${units}`, user, units),
    { name: 'Profile', plane: 'XY', offset: 0, object }
  ).document;
  const sketchId = getLatestSketchId(sketched)!;
  const sketch = findSketch(sketched, sketchId)!;
  const objectId = sketch.objectIds[0]!;
  const profiles = selectedRegion
    ? computeSketchRegions([{ id: objectId, data: object }], (value) =>
        resolveParamValue(value, {}, 'sketch dimension', units)
      ).map((profile) => ({
        profileId: profile.profileId,
        regionFingerprint: profile.regionFingerprint,
        sourceArea: profile.area,
        samplePoint: profile.samplePoint,
        sourceEntityIds: profile.sourceEntityIds
      }))
    : undefined;
  return extrudeSketch(sketched, {
    name: 'Extrude',
    sketchId,
    distance: '12 mm',
    backDistance: '0.3 cm',
    ...(profiles ? { profiles } : {})
  }).document;
}

describe(
  'sketch and extrusion expressions in document units',
  { timeout: 60_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });
    afterAll(() => adapter.dispose());

    it.each([
      ['mm', 1],
      ['cm', 0.1],
      ['inch', 1 / 25.4]
    ] as const)(
      'replays equivalent %s whole-object and selected-region extrusions, including side references',
      async (units, scale) => {
        for (const selectedRegion of [false, true]) {
          const document = fixture(units, rectangle(), selectedRegion);
          const derived = await adapter.syncDocument(document);
          const body = derived.bodyRepresentations[getLatestBodyId(document)!]!;
          expect(derived.warnings).toEqual([]);
          expect(body.volume).toBeCloseTo(25 * 10 * 15 * scale ** 3, 8);
          expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(25 * scale, 9);
          expect(body.bbox.max.y - body.bbox.min.y).toBeCloseTo(10 * scale, 9);
          expect(body.bbox.min.z).toBeCloseTo(-3 * scale, 9);
          expect(body.bbox.max.z).toBeCloseTo(12 * scale, 9);
          // Resolving the face alone is insufficient: side roles also read the
          // authored sketch values and must retain attachment identity.
          expect(body.topology!.faces).toHaveLength(6);
          expect(body.topology!.faces.every((face) => face.reference)).toBe(
            true
          );
          expect(body.topology!.lineageDiagnostics ?? []).toEqual([]);
        }
      }
    );

    it('resolves circle centers/radii and polygon profiles in the whole-object path', async () => {
      for (const object of [
        { objectKind: 'circle', radius: '5 mm', centerX: '1 cm', centerY: 0 },
        {
          objectKind: 'polygon',
          sides: 4,
          radius: '5 mm',
          centerX: '1 cm',
          centerY: 0
        }
      ] satisfies SketchObjectData[]) {
        const document = fixture('cm', object);
        const derived = await adapter.syncDocument(document);
        const body = derived.bodyRepresentations[getLatestBodyId(document)!]!;
        expect(derived.warnings).toEqual([]);
        const area =
          object.objectKind === 'circle' ? Math.PI * 0.5 ** 2 : 2 * 0.5 ** 2;
        expect(body.volume).toBeCloseTo(area * 1.5, 8);
        expect(body.bbox.min.x).toBeCloseTo(0.5, 8);
        expect(body.bbox.max.x).toBeCloseTo(1.5, 8);
        expect(body.topology!.faces.every((face) => face.reference)).toBe(true);
      }
    });

    it('keeps authored sketch and extrusion expressions through preview, commit, undo/redo and reopen', async () => {
      const manager = new CommandManager(
        createProjectDocument('Expression lifecycle', user, 'mm')
      );
      manager.execute(
        commandFactories.addSketch({
          name: 'Profile',
          plane: 'XY',
          offset: 0,
          object: {
            objectKind: 'rectangle',
            width: 20,
            height: 10,
            centerX: 0,
            centerY: 0
          }
        })
      );
      const sketchId = getLatestSketchId(manager.document)!;
      const objectId = findSketch(manager.document, sketchId)!.objectIds[0]!;
      manager.execute(
        commandFactories.updateSketchObject({
          sketchId,
          objectId,
          data: rectangle()
        })
      );
      manager.execute(
        commandFactories.extrudeSketch({
          name: 'Extrude',
          sketchId,
          distance: 8
        })
      );
      const bodyId = getLatestBodyId(manager.document)!;
      const featureId = listFeaturesInOrder(manager.document).at(-1)!.featureId;
      const baseline = manager.document;
      const edit = {
        featureId,
        data: { distance: '12 mm', backDistance: '0.3 cm' }
      };
      const preview = updateFeature(manager.document, edit);
      const volume = async (document: ProjectDocument) => {
        const derived = await adapter.syncDocument(document);
        expect(derived.warnings).toEqual([]);
        return derived.bodyRepresentations[bodyId]!.volume;
      };
      expect(await volume(preview)).toBeCloseTo(3_750, 8);
      expect(manager.document).toBe(baseline);
      expect(await volume(manager.document)).toBeCloseTo(2_000, 8);
      manager.execute(commandFactories.updateFeature(edit));
      expect(await volume(manager.document)).toBeCloseTo(3_750, 8);
      manager.undo();
      expect(await volume(manager.document)).toBeCloseTo(2_000, 8);
      manager.redo();
      expect(await volume(manager.document)).toBeCloseTo(3_750, 8);
      const reopened = normalizeDocument(
        JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
      );
      expect(reopened.nodes[objectId]).toMatchObject({ data: rectangle() });
      expect(listFeaturesInOrder(reopened).at(-1)!.data).toMatchObject(
        edit.data
      );
      expect(await volume(reopened)).toBeCloseTo(3_750, 8);
    });

    it('refuses unresolved unit expressions rather than inventing a value on replay', async () => {
      const document = fixture('inch');
      const feature = listFeaturesInOrder(document).at(-1)!;
      const invalid = updateFeature(document, {
        featureId: feature.featureId,
        data: { backDistance: 'missing + 2 mm' }
      });
      const derived = await adapter.syncDocument(invalid);
      expect(
        derived.bodyRepresentations[getLatestBodyId(document)!]
      ).toBeUndefined();
      expect(derived.warnings.join(' ')).toMatch(/back distance.*missing/);
    });
  }
);
