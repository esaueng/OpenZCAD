import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addDatumPlane,
  createProjectDocument,
  gearBody,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FacePlaneSource,
  type FaceTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';
import {
  edgeNamed,
  expectRimBlend,
  modifyEdge
} from './support/gear-edge-fixtures';

/**
 * M14: a face the toothed cylinder runs into, a flange it ends on, is not
 * that cylinder's cap. Whole-face teeth leave it the name the body's lineage
 * carries; teeth along part of the face used to rename it
 * `gear.face.cap.end`, so a datum on it, and a fillet on its untouched outer
 * rim (named from its two faces), lost their reference when the teeth went
 * from the whole face to part of it, although neither had moved.
 */

/** The flange's faces, as the union and then the teeth carry them. */
const FLANGE = 'boolean.face.target.boolean.face.operand.1.primitive.cylinder.face';
const UNDERSIDE = `${FLANGE}.cap.start`;
const TOP = `${FLANGE}.cap.end`;
const WALL = `${FLANGE}.wall`;

/** A gear edge's name from its two faces' full names. */
function edgeBetween(first: string, second: string): string {
  const names = [first, second].sort();
  return `gear.edge.between.${names[0]}|${names[1]}`;
}

const WHOLE = { clearData: ['faceWidth', 'offset', 'anchor'] };

describe('teeth beside a flange (M14)', { timeout: 600_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => adapter.dispose());

  /**
   * A Ø22 shaft 30 long with a Ø26 flange from 14 to 18, and set-module
   * teeth along the whole Ø22 below the flange (`lower`, 0 to 14) or above
   * it (`upper`, 18 to 30).
   */
  async function steppedGear(pick: 'lower' | 'upper'): Promise<{
    document: ProjectDocument;
    bodyId: BodyId;
    body: BodyRepresentation;
    gearId: FeatureId;
  }> {
    let document = createProjectDocument('Shaft', toUserId('user_gear_edges'));
    document = commandFactories
      .addPrimitive({
        name: 'Shaft',
        primitiveKind: 'cylinder',
        dimensions: { radius: 11, height: 30 }
      })
      .apply(document);
    document = commandFactories
      .addPrimitive({
        name: 'Flange',
        primitiveKind: 'cylinder',
        dimensions: { radius: 13, height: 4 }
      })
      .apply(document);
    const [shaftId, flangeId] = document.bodyOrder as [BodyId, BodyId];
    document = commandFactories
      .transformBody({
        name: 'Raise',
        targetBodyId: flangeId,
        translation: { x: 0, y: 0, z: 14 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      })
      .apply(document);
    document = commandFactories
      .booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [shaftId, flangeId]
      })
      .apply(document);
    const stepped = document.bodyOrder.at(-1)!;
    const wall = (await adapter.syncDocument(document)).bodyRepresentations[
      stepped
    ]!.topology!.faces.find((face) => {
      if (
        face.geometry?.surfaceType !== 'cylinder' ||
        Math.abs(face.geometry.radius! - 11) > 1e-9
      ) {
        return false;
      }
      const ends = [face.geometry.axisStart!.z, face.geometry.axisEnd!.z];
      return pick === 'lower' ? Math.max(...ends) < 15 : Math.min(...ends) > 17;
    })!;
    const cut = gearBody(document, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      pitch: 0.9,
      fit: 'module',
      teeth: 20,
      targetBodyId: stepped,
      faceHash: wall.hash,
      ...(wall.reference ? { faceReference: wall.reference } : {})
    });
    const derived = await adapter.syncDocument(cut.document);
    expect(derived.warnings).toEqual([]);
    return {
      document: cut.document,
      bodyId: cut.bodyId,
      body: derived.bodyRepresentations[cut.bodyId]!,
      gearId: listFeaturesInOrder(cut.document).find(
        (feature) => feature.data.featureKind === 'gear'
      )!.featureId
    };
  }

  function faceNamed(body: BodyRepresentation, name: string): FaceTopology {
    const faces = body.topology!.faces.filter(
      (face) => face.reference?.lineageName === name
    );
    expect(faces, name).toHaveLength(1);
    return faces[0]!;
  }

  /** The spans the teeth take in turn, from the whole face and back to it. */
  const SPANS = [
    ['part of the face', { data: { faceWidth: 6, offset: 3 } }],
    ['whole face again', WHOLE],
    // Up to the flange: a shoulder opens in the flange's own plane.
    ['up to the flange', { data: { faceWidth: 6, anchor: 'end' as const } }],
    ['set off from the flange', { data: { faceWidth: 6, offset: 2 } }],
    ['from the free end', { data: { faceWidth: 6 }, clearData: ['offset', 'anchor'] }],
    ['whole face at last', WHOLE]
  ] as const;

  it('keeps the flange face’s carried name, and only the cylinder’s own cap as a gear cap, at every span', async () => {
    const gear = await steppedGear('lower');
    const whole = gear.body;
    const names = (body: BodyRepresentation) =>
      body.topology!.faces.map((face) => face.reference?.lineageName);
    // The cylinder's free end is its own cap; the flange is not.
    expect(names(whole)).toContain('gear.face.cap.start');
    expect(names(whole)).not.toContain('gear.face.cap.end');
    const underside = faceNamed(whole, UNDERSIDE);
    const rim = edgeNamed(whole, edgeBetween(UNDERSIDE, WALL));
    let document = gear.document;
    for (const [step, edit] of SPANS) {
      document = updateFeature(document, { featureId: gear.gearId, ...edit });
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings, step).toEqual([]);
      const body = derived.bodyRepresentations[gear.bodyId]!;
      const published = names(body);
      expect(
        new Set(published.filter((name) => name !== undefined)).size,
        step
      ).toBe(published.filter((name) => name !== undefined).length);
      // The flange's underside, its top and its wall: the names they had.
      const face = faceNamed(body, UNDERSIDE);
      expect(face.geometry!.center.z, step).toBeCloseTo(14, 9);
      faceNamed(body, TOP);
      faceNamed(body, WALL);
      // No gear cap at the flange, whole or split.
      for (const name of published) {
        expect(name ?? '', step).not.toMatch(/^gear\.face\.cap\.end/);
      }
      // The untouched rim: the same edge under the same name.
      expect(edgeNamed(body, edgeBetween(UNDERSIDE, WALL)).hash, step).toBe(
        rim.hash
      );
      if (step === 'up to the flange') {
        // The teeth end at a shoulder like any other, in the flange's plane
        // beside the flange face, which is left exactly as the union made it.
        const shoulder = faceNamed(body, 'gear.face.shoulder.end');
        expect(shoulder.geometry!.center.z).toBeCloseTo(14, 9);
        expect(face.geometry!.area).toBeCloseTo(
          Math.PI * (13 ** 2 - 11 ** 2),
          6
        );
        expect(published).not.toContain('gear.face.collar.end');
      }
    }
    // Back on the whole face: the body as it first was, names and hashes.
    const again = (await adapter.syncDocument(document)).bodyRepresentations[
      gear.bodyId
    ]!;
    expect(faceNamed(again, UNDERSIDE).hash).toBe(underside.hash);
    expect(
      again.topology!.faces.map(
        (face) => `${face.reference?.lineageName}:${face.hash}`
      )
    ).toEqual(
      whole.topology!.faces.map(
        (face) => `${face.reference?.lineageName}:${face.hash}`
      )
    );
  });

  it.each(['fillet', 'chamfer'] as const)(
    'keeps a %s on the flange’s outer rim from whole-face teeth to part of the face and back',
    async (kind) => {
      const gear = await steppedGear('lower');
      // Where the flange's underside meets its Ø26 wall: no tooth is near it.
      const rim = edgeNamed(gear.body, edgeBetween(UNDERSIDE, WALL));
      const size = 0.3;
      const modified = modifyEdge(kind, gear.document, gear.bodyId, rim, size);
      let document = modified.document;
      const ids = { gear: gear.bodyId, modified: modified.bodyId };
      const blend = {
        kind,
        radius: 13,
        size,
        side: 'outer' as const,
        z: 14
      };
      expectRimBlend(await adapter.syncDocument(document), 'whole face', ids, blend);
      for (const [step, edit] of SPANS) {
        document = updateFeature(document, { featureId: gear.gearId, ...edit });
        expectRimBlend(await adapter.syncDocument(document), step, ids, blend);
      }
    }
  );

  it('keeps a datum plane on the flange face from whole-face teeth to part of the face and back, below the flange and above it', async () => {
    for (const [pick, name, z] of [
      ['lower', UNDERSIDE, 14],
      ['upper', TOP, 18]
    ] as const) {
      const gear = await steppedGear(pick);
      const face = faceNamed(gear.body, name);
      const attachment = faceSketchAttachment({
        bodyId: gear.bodyId,
        pickedHash: face.hash,
        face
      });
      if (!attachment.ok) throw new Error(attachment.reason);
      const planed = addDatumPlane(gear.document, {
        name: 'On the flange',
        definition: {
          kind: 'offset',
          source: attachment.planeRef as FacePlaneSource,
          offset: 0
        }
      });
      let document = planed.document;
      const first = await adapter.syncDocument(document);
      expect(first.warnings).toEqual([]);
      expect(first.datumFrames?.[planed.featureId]?.origin.z).toBeCloseTo(z, 6);
      // Above the flange the teeth start at it; below, they end at it.
      const toFlange =
        pick === 'lower'
          ? { data: { faceWidth: 6, anchor: 'end' as const } }
          : { data: { faceWidth: 6 } };
      for (const [step, edit] of [
        ['part of the face', { data: { faceWidth: 6, offset: 3 } }],
        ['whole face again', WHOLE],
        ['up to the flange', toFlange],
        ['whole face at last', WHOLE]
      ] as const) {
        document = updateFeature(document, { featureId: gear.gearId, ...edit });
        const derived = await adapter.syncDocument(document);
        expect(derived.warnings, `${pick} ${step}`).toEqual([]);
        expect(
          derived.datumFrames?.[planed.featureId]?.origin.z,
          `${pick} ${step}`
        ).toBeCloseTo(z, 6);
      }
    }
  });
});
