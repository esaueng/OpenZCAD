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
  OFFSET_SET_NOT_SAME_NORMAL,
  buildOffsetFaceSetLead,
  buildOffsetFaces,
  faceSetOffsetPlanes,
  faceSetOffsetStart,
  faceSetOffsetTicks,
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

  it('arms parallel faces at different heights as one chained set', () => {
    const start = faceSetOffsetStart(slottedBlock(), [
      pick(leftTop),
      pick(floor)
    ]);
    expect(start.face.hash).toBe(floor.hash);
    expect(start.members).toEqual([{ topologyId: 'face:1', hash: 1 }]);
  });

  it('refuses faces that face different ways before any handle appears', () => {
    expect(() =>
      faceSetOffsetStart(slottedBlock(), [pick(leftTop), pick(wall)])
    ).toThrow(OFFSET_SET_NOT_SAME_NORMAL);
  });

  it('orders a chained set by plane, the plane the move leads with first', () => {
    const input = {
      document: slottedBlock(),
      bodyId: BODY,
      face: { topologyId: floor.topologyId, hash: floor.hash },
      members: [leftTop, rightTop].map((face) => ({
        topologyId: face.topologyId,
        hash: face.hash
      }))
    };
    const hashes = (planes: FaceTopology[][] | null) =>
      planes?.map((group) => group.map((face) => face.hash));
    // Pushed out, the top moves first and the floor follows into its room;
    // pulled in, the floor leads.
    expect(hashes(faceSetOffsetPlanes(input, 2))).toEqual([[1, 2], [3]]);
    expect(hashes(faceSetOffsetPlanes(input, -2))).toEqual([[3], [1, 2]]);
    expect(
      hashes(
        faceSetOffsetPlanes(
          {
            ...input,
            face: { topologyId: rightTop.topologyId, hash: rightTop.hash },
            members: [{ topologyId: leftTop.topologyId, hash: leftTop.hash }]
          },
          2
        )
      )
    ).toEqual([[2, 1]]);
    expect(
      faceSetOffsetPlanes(
        { ...input, members: [{ topologyId: 'face:99', hash: 99 }] },
        2
      )
    ).toBeNull();
  });

  it('previews a chained set’s leading plane alone, and nothing for one plane', () => {
    const input = {
      document: slottedBlock(),
      bodyId: BODY,
      face: { topologyId: floor.topologyId, hash: floor.hash },
      members: [leftTop, rightTop].map((face) => ({
        topologyId: face.topologyId,
        hash: face.hash
      }))
    };
    const operation = (command: ReturnType<typeof buildOffsetFaceSetLead>) =>
      (command?.payload as { operation?: DirectEditOperation } | undefined)
        ?.operation;
    const out = operation(buildOffsetFaceSetLead({ ...input, offset: 2 }));
    expect(out).toMatchObject({
      kind: 'offset-faces',
      faceHash: 1,
      offset: 2,
      additionalFaces: [{ faceHash: 2 }]
    });
    // The floor leads a cut alone: the one-face move of it.
    expect(
      operation(buildOffsetFaceSetLead({ ...input, offset: -2.00049 }))
    ).toEqual({
      kind: 'offset-face',
      faceHash: 3,
      sourceSurfaceType: 'plane',
      sourceArea: 200,
      sourceCenter: floor.geometry!.center,
      sourceNormal: UP,
      offset: -2
    });
    expect(
      buildOffsetFaceSetLead({
        ...input,
        face: { topologyId: rightTop.topologyId, hash: rightTop.hash },
        members: [{ topologyId: leftTop.topologyId, hash: leftTop.hash }],
        offset: 2
      })
    ).toBeNull();
  });

  it('places a direction tick on every face of the set, the handle’s last', () => {
    const tilted = plane(6, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 4 });
    const document = slottedBlock();
    const body = document.derived.bodyRepresentations[BODY]!;
    body.topology!.faces.push(tilted);
    expect(
      faceSetOffsetTicks({
        document,
        bodyId: BODY,
        face: { topologyId: floor.topologyId, hash: floor.hash },
        members: [
          { topologyId: leftTop.topologyId, hash: leftTop.hash },
          { topologyId: tilted.topologyId, hash: tilted.hash }
        ]
      })
    ).toEqual([
      { point: leftTop.geometry!.center, normal: UP },
      // Unit length, whatever the stored normal's length.
      { point: tilted.geometry!.center, normal: UP },
      { point: floor.geometry!.center, normal: UP }
    ]);
    expect(
      faceSetOffsetTicks({
        document,
        bodyId: BODY,
        face: { topologyId: floor.topologyId, hash: floor.hash },
        members: [{ topologyId: bore.topologyId, hash: bore.hash }]
      })
    ).toEqual([]);
  });

  it('withholds the verb, with the reason, from sets that cannot move together', () => {
    const document = slottedBlock();
    expect(
      faceSetOffsetUnavailable(document, [pick(leftTop), pick(rightTop)])
    ).toBeNull();
    // Flat and parallel at another height: offered, and it arms.
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
