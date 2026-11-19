import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DirectEditOperation,
  type FaceTopology,
  type ProjectDocument,
  type TopologySelection,
  type Vector3
} from '@openzcad/shared';
import {
  OFFSET_SET_NOT_COPLANAR,
  OFFSET_SET_NOT_SAME_NORMAL,
  buildOffsetFaces,
  faceSetOffsetStart,
  faceSetOffsetUnavailable,
  offsetFacesCommitMessage,
  offsetFacesName
} from './faceSetOffset';

const BODY = 'body_block' as BodyId;
const UP = { x: 0, y: 0, z: 1 };

function plane(
  hash: number,
  center: Vector3,
  normal: Vector3 = UP,
  area = 300
): FaceTopology {
  return {
    topologyId: `face:${hash}`,
    hash,
    geometry: { surfaceType: 'plane', area, center, normal }
  } as unknown as FaceTopology;
}

const leftTop = plane(1, { x: 7.5, y: 10, z: 10 });
const rightTop = plane(2, { x: 32.5, y: 10, z: 10 });
const floor = plane(3, { x: 20, y: 10, z: 5 }, UP, 200);
const wall = plane(4, { x: 15, y: 10, z: 7.5 }, { x: 1, y: 0, z: 0 }, 100);
const bore = {
  topologyId: 'face:5',
  hash: 5,
  geometry: {
    surfaceType: 'cylinder',
    area: 50,
    center: { x: 20, y: 10, z: 2 }
  }
} as unknown as FaceTopology;

function slottedBlock(): ProjectDocument {
  const document = createProjectDocument(
    'Slotted block',
    toUserId('user_face_set_offset')
  );
  return {
    ...document,
    derived: {
      ...document.derived,
      bodyRepresentations: {
        [BODY]: {
          bodyId: BODY,
          consumed: false,
          topology: {
            faces: [leftTop, rightTop, floor, wall, bore],
            edges: []
          }
        }
      } as unknown as ProjectDocument['derived']['bodyRepresentations']
    }
  };
}

const pick = (face: FaceTopology, bodyId = BODY): TopologySelection => ({
  bodyId,
  kind: 'face',
  topologyId: face.topologyId,
  hash: face.hash
});

describe('face set offset', () => {
  it('arms on the last-picked face and carries the others in pick order', () => {
    const start = faceSetOffsetStart(slottedBlock(), [
      pick(leftTop),
      pick(rightTop)
    ]);
    expect(start.face.hash).toBe(rightTop.hash);
    expect(start.normal).toEqual(UP);
    expect(start.members).toEqual([{ topologyId: 'face:1', hash: 1 }]);
  });

  it('refuses a set that is not one plane before any handle appears', () => {
    const document = slottedBlock();
    expect(() =>
      faceSetOffsetStart(document, [pick(leftTop), pick(floor)])
    ).toThrow(OFFSET_SET_NOT_COPLANAR);
    expect(() =>
      faceSetOffsetStart(document, [pick(leftTop), pick(wall)])
    ).toThrow(OFFSET_SET_NOT_SAME_NORMAL);
  });

  it('withholds the verb, with the reason, from sets that cannot move together', () => {
    const document = slottedBlock();
    expect(
      faceSetOffsetUnavailable(document, [pick(leftTop), pick(rightTop)])
    ).toBeNull();
    // Flat but not one plane: offered, then refused by name when chosen.
    expect(
      faceSetOffsetUnavailable(document, [pick(leftTop), pick(floor)])
    ).toBeNull();
    expect(faceSetOffsetUnavailable(document, [pick(leftTop)])).toBe(
      'Select two or more faces to offset them together.'
    );
    expect(
      faceSetOffsetUnavailable(document, [pick(leftTop), pick(bore)])
    ).toBe('Offset moves flat faces together. Select only flat faces.');
    expect(
      faceSetOffsetUnavailable(document, [
        pick(leftTop),
        pick(rightTop, 'body_other' as BodyId)
      ])
    ).toBe(
      'Faces on different bodies cannot be offset together. Select faces on one body.'
    );
    expect(
      faceSetOffsetUnavailable(document, [
        pick(leftTop),
        { ...pick(rightTop), topologyId: 'face:99', hash: 99 }
      ])
    ).toBe(
      'A selected face is no longer on the model. Select the faces again.'
    );
  });

  it('builds one offset-faces edit with every face pinned as it is now', () => {
    const command = buildOffsetFaces({
      document: slottedBlock(),
      bodyId: BODY,
      face: { topologyId: rightTop.topologyId, hash: rightTop.hash },
      members: [{ topologyId: leftTop.topologyId, hash: leftTop.hash }],
      offset: 2.00049
    });
    expect(command?.label).toBe('Offset 2 faces');
    const operation = (
      command?.payload as { operation?: DirectEditOperation } | undefined
    )?.operation;
    expect(operation).toEqual({
      kind: 'offset-faces',
      faceHash: 2,
      sourceSurfaceType: 'plane',
      sourceArea: 300,
      sourceCenter: rightTop.geometry!.center,
      sourceNormal: UP,
      offset: 2,
      additionalFaces: [
        {
          faceHash: 1,
          sourceSurfaceType: 'plane',
          sourceArea: 300,
          sourceCenter: leftTop.geometry!.center,
          sourceNormal: UP
        }
      ]
    });
  });

  it('keeps a typed expression live instead of the number', () => {
    const command = buildOffsetFaces({
      document: slottedBlock(),
      bodyId: BODY,
      face: { topologyId: rightTop.topologyId, hash: rightTop.hash },
      members: [{ topologyId: leftTop.topologyId, hash: leftTop.hash }],
      offset: 4,
      exact: 'lift * 2'
    });
    expect(
      (command?.payload as { operation?: { offset?: unknown } }).operation
        ?.offset
    ).toBe('lift * 2');
  });

  it('builds nothing for a face that no longer resolves', () => {
    expect(
      buildOffsetFaces({
        document: slottedBlock(),
        bodyId: BODY,
        face: { topologyId: rightTop.topologyId, hash: rightTop.hash },
        members: [{ topologyId: 'face:99', hash: 99 }],
        offset: 2
      })
    ).toBeNull();
  });

  it('names the step by count and reports the signed change', () => {
    expect(offsetFacesName(3)).toBe('Offset 3 faces');
    expect(offsetFacesCommitMessage(2, 2, 'mm')).toBe(
      'Offset 2 faces by +2 mm.'
    );
    expect(offsetFacesCommitMessage(4, -1.234, 'in')).toBe(
      'Offset 4 faces by -1.23 in.'
    );
  });
});
