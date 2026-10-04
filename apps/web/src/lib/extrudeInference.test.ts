import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  getLatestBodyId,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toBodyId, toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  combinedVerdictIsUniform,
  mixedExtrudeRefusal,
  regionInferenceRefusal,
  resolveExtrudeOperation
} from './extrudeInference';
import { faceSketchAttachment } from './faceSketchAttachment';

const plate = toBodyId('body_plate');
const block = toBodyId('body_block');

describe('mixedExtrudeRefusal', () => {
  it('accepts profiles that all do the same thing to the same body', () => {
    expect(
      mixedExtrudeRefusal([
        { operation: 'cut', targetBodyId: plate },
        { operation: 'cut', targetBodyId: plate }
      ])
    ).toBeNull();
    expect(
      mixedExtrudeRefusal([
        { operation: 'new-body' },
        { operation: 'new-body' }
      ])
    ).toBeNull();
    expect(mixedExtrudeRefusal([])).toBeNull();
  });

  it('refuses a cut beside an add in one plain sentence', () => {
    const refusal = mixedExtrudeRefusal([
      { operation: 'cut', targetBodyId: plate },
      { operation: 'add', targetBodyId: plate }
    ]);
    expect(refusal).toBe(
      'One selected profile would cut into the body and another would add to the body, so extrude them separately or choose an operation.'
    );
  });

  it('refuses a pocket beside a profile that would land in the air', () => {
    expect(
      mixedExtrudeRefusal([
        { operation: 'cut', targetBodyId: plate },
        { operation: 'new-body' }
      ])
    ).toMatch(/would cut into the body and another would make a new body/);
  });

  it('refuses one operation aimed at two different bodies', () => {
    expect(
      mixedExtrudeRefusal([
        { operation: 'add', targetBodyId: plate },
        { operation: 'add', targetBodyId: block }
      ])
    ).toBe(
      'The selected profiles sit over different bodies; extrude them separately.'
    );
  });
});

describe('combinedVerdictIsUniform', () => {
  it('trusts only verdicts every profile must share', () => {
    for (const reason of [
      'explicit',
      'enclosed',
      'no-overlap',
      'no-live-body'
    ] as const) {
      expect(combinedVerdictIsUniform(reason)).toBe(true);
    }
    // A boss onto its sketched face is decided by the attachment, not
    // measured, so a profile beside the face can hide behind it.
    for (const reason of [
      'onto-face-body',
      'into-face-body',
      'partial-overlap',
      'multiple-overlap'
    ] as const) {
      expect(combinedVerdictIsUniform(reason)).toBe(false);
    }
  });
});

describe(
  'regionInferenceRefusal on a face-attached sketch',
  { timeout: 30_000 },
  () => {
    let kernel: ExactKernelAdapter;
    beforeAll(async () => {
      kernel = await createExactKernelAdapter();
    });
    afterAll(() => kernel.dispose());

    it('refuses a boss on the face beside a profile off it', async () => {
      const base = addPrimitiveFeature(
        createProjectDocument('Face bosses', toUserId('user_face_bosses')),
        {
          name: 'Base',
          primitiveKind: 'box',
          dimensions: { width: 20, height: 20, depth: 10 }
        }
      );
      const bodyId = base.bodyOrder[0]!;
      const derived = await kernel.syncDocument(base);
      const top = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
        (face) => face.reference?.lineageName === 'primitive.box.face.z-max'
      )!;
      const attachment = faceSketchAttachment({
        bodyId,
        pickedHash: top.hash,
        face: top
      });
      if (!attachment.ok) throw new Error(attachment.reason);
      // The face frame sits on the face's centroid: one circle on the face, one
      // well beside the 20 mm box.
      const { document, sketchId } = addSketchFeature(
        { ...base, derived },
        {
          name: 'Bosses',
          planeRef: attachment.planeRef,
          objects: [
            { objectKind: 'circle', radius: 3, centerX: 0, centerY: 0 },
            { objectKind: 'circle', radius: 3, centerX: 40, centerY: 0 }
          ]
        }
      );
      const [onFace, besideFace] = findSketch(document, sketchId)!.objectIds;
      const options = {
        base: document,
        input: {
          name: 'Bosses',
          sketchId,
          distance: 6,
          profiles: [
            { all: true as const, sourceEntityIds: [onFace!] },
            { all: true as const, sourceEntityIds: [besideFace!] }
          ]
        },
        derive: (next: ProjectDocument) => kernel.syncDocument(next),
        faceAttachment: { bodyId, direction: 'away' as const }
      };
      // Whether the combined add builds or not, its verdict comes from the
      // attachment, and the selection must still be refused.
      const combined = await resolveExtrudeOperation(options).then(
        (resolved) => resolved.inference,
        () => null
      );
      if (combined) {
        expect(combined.reason).toBe('onto-face-body');
      }
      await expect(regionInferenceRefusal(options, combined)).resolves.toBe(
        'One selected profile would add to the body and another would make a new body, so extrude them separately or choose an operation.'
      );
    });
  }
);

describe('regionInferenceRefusal over two bodies', { timeout: 30_000 }, () => {
  let kernel: ExactKernelAdapter;
  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });
  afterAll(() => kernel.dispose());

  it('refuses two pockets that would cut two different bodies', async () => {
    let base = createProjectDocument('Two plates', toUserId('user_two_plates'));
    base = addPrimitiveFeature(base, {
      name: 'Left',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    base = addPrimitiveFeature(base, {
      name: 'Right',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    base = transformBody(base, {
      name: 'Place right',
      targetBodyId: getLatestBodyId(base)!,
      translation: { x: 40, y: 0, z: 0 }
    }).document;
    const { document, sketchId } = addSketchFeature(base, {
      name: 'Pockets',
      plane: 'XY',
      offset: 10,
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 10,
          centerY: 10
        },
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 50,
          centerY: 10
        }
      ]
    });
    const [left, right] = findSketch(document, sketchId)!.objectIds;
    const options = {
      base: { ...document, derived: await kernel.syncDocument(document) },
      input: {
        name: 'Pockets',
        sketchId,
        distance: -4,
        profiles: [
          { all: true as const, sourceEntityIds: [left!] },
          { all: true as const, sourceEntityIds: [right!] }
        ]
      },
      derive: (next: ProjectDocument) => kernel.syncDocument(next)
    };
    const combined = await resolveExtrudeOperation(options).then(
      (resolved) => resolved.inference,
      () => null
    );
    // Each alone cuts its own plate; together no single target holds both.
    expect(combined?.reason ?? null).not.toBe('enclosed');
    await expect(regionInferenceRefusal(options, combined)).resolves.toBe(
      'The selected profiles sit over different bodies; extrude them separately.'
    );
  });
});
