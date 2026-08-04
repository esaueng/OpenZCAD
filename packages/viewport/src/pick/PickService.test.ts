import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toBodyId } from '@openzcad/shared';
import {
  PickService,
  type ProfilePickTarget,
  type PickServiceOptions
} from './PickService';
import type { RegionPickData, SelectionFilter } from '../types';
import { createBodyEdgeOverlay } from '../render/edgeOverlay';

/**
 * The service only calls `getBoundingClientRect`, so a stub keeps these tests
 * in the node environment alongside the rest of the package.
 */
function stubElement(size = 100): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: size,
      height: size
    })
  } as unknown as HTMLElement;
}

/** A pointer event at the centre of the stub element: a ray straight down -Z. */
function centreEvent(size = 100): MouseEvent {
  return { clientX: size / 2, clientY: size / 2 } as MouseEvent;
}

function planeAt(z: number, userData: Record<string, unknown>): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshBasicMaterial()
  );
  mesh.position.z = z;
  mesh.userData = userData;
  mesh.updateMatrixWorld(true);
  return mesh;
}

function batchedBody(bodyId: string, z = 0) {
  const body = new THREE.Group();
  body.position.z = z;
  body.userData.bodyId = bodyId;
  body.add(
    createBodyEdgeOverlay(
      {
        bodyId: toBodyId(bodyId),
        topology: {
          faces: [],
          edges: [
            {
              topologyId: `edge-${bodyId}`,
              hash: bodyId.length,
              points: [-4, 0, 0, 0, 0, 0, 4, 0, 0]
            }
          ]
        }
      },
      { width: 100, height: 100 }
    )
  );
  body.updateMatrixWorld(true);
  return body;
}

interface Groups {
  regionGroup: THREE.Group;
  sketchGroup: THREE.Group;
  bodyGroup: THREE.Group;
}

function makeService(
  groups: Partial<Groups> = {},
  filter?: SelectionFilter,
  options: Pick<PickServiceOptions, 'profiles' | 'selectionContext'> = {}
) {
  const regionGroup = groups.regionGroup ?? new THREE.Group();
  const sketchGroup = groups.sketchGroup ?? new THREE.Group();
  const bodyGroup = groups.bodyGroup ?? new THREE.Group();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const service = new PickService({
    domElement: stubElement(),
    camera: () => camera,
    regionGroup,
    sketchGroup,
    bodyGroup,
    filter: filter ? () => filter : undefined,
    ...options
  });
  return { service, regionGroup, sketchGroup, bodyGroup };
}

const REGION = {
  sketchId: 'sketch-1',
  regionFingerprint: 42,
  samplePoint: { x: 0, y: 0 },
  area: 100
};

function projectedProfile(
  profileId: string,
  outer = [
    { x: -4, y: -4 },
    { x: 4, y: -4 },
    { x: 4, y: 4 },
    { x: -4, y: 4 }
  ],
  holes: { x: number; y: number }[][] = []
): ProfilePickTarget {
  const pick: RegionPickData = {
    sketchId: 'sketch-1',
    profileId,
    regionFingerprint: profileId.length,
    samplePoint: { x: -3, y: 0 },
    centroid: { x: 0, y: 0 },
    boundingBox: {
      min: { x: -4, y: -4 },
      max: { x: 4, y: 4 }
    },
    sourceEntityIds: ['entity-1'],
    area: 64
  };
  return {
    pick,
    object: new THREE.Object3D(),
    basis: {
      origin: { x: 0, y: 0, z: 0 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 }
    },
    outer,
    holes
  };
}

describe('region picking respects occlusion', () => {
  it('selects a detected region when nothing covers it', () => {
    const regionGroup = new THREE.Group();
    regionGroup.add(planeAt(0, { region: REGION }));
    const { service } = makeService({ regionGroup });

    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('region');
    expect(pick?.region).toEqual(REGION);
  });

  it('lets a solid standing on the sketch plane occlude the region', () => {
    const regionGroup = new THREE.Group();
    regionGroup.add(planeAt(0, { region: REGION }));
    const bodyGroup = new THREE.Group();
    // Nearer the camera than the region, so it wins the pointer.
    const blocker = planeAt(5, { bodyId: 'body-1' });
    let bodyRaycasts = 0;
    const raycast = blocker.raycast;
    blocker.raycast = (raycaster, intersections) => {
      bodyRaycasts += 1;
      raycast.call(blocker, raycaster, intersections);
    };
    bodyGroup.add(blocker);
    const { service } = makeService({ regionGroup, bodyGroup });

    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('body');
    expect(pick?.selection).toEqual({ bodyId: 'body-1', kind: 'body' });
    expect(bodyRaycasts).toBe(1);
  });

  it('keeps the region when the body is behind it', () => {
    const regionGroup = new THREE.Group();
    regionGroup.add(planeAt(5, { region: REGION }));
    const bodyGroup = new THREE.Group();
    bodyGroup.add(planeAt(0, { bodyId: 'body-1' }));
    const { service } = makeService({ regionGroup, bodyGroup });

    expect(service.pick(centreEvent())?.kind).toBe('region');
  });

  it('ignores a hidden body when deciding whether the region is covered', () => {
    const regionGroup = new THREE.Group();
    regionGroup.add(planeAt(0, { region: REGION }));
    const bodyGroup = new THREE.Group();
    const hidden = planeAt(5, { bodyId: 'body-1' });
    hidden.visible = false;
    bodyGroup.add(hidden);
    const { service } = makeService({ regionGroup, bodyGroup });

    expect(service.pick(centreEvent())?.kind).toBe('region');
  });
});

describe('command-aware projected profile picking', () => {
  it('lets a valid profile outrank its coincident body face during Extrude', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(planeAt(0, { bodyId: 'body-1' }));
    const profile = projectedProfile('profile-a');
    const { service } = makeService({ bodyGroup }, undefined, {
      profiles: () => [profile],
      selectionContext: () => 'profile-command'
    });

    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('region');
    expect(pick?.region?.profileId).toBe('profile-a');
  });

  it('preserves normal depth occlusion outside profile commands', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(planeAt(5, { bodyId: 'body-1' }));
    const profile = projectedProfile('profile-a');
    const { service } = makeService({ bodyGroup }, undefined, {
      profiles: () => [profile],
      selectionContext: () => 'default'
    });

    expect(service.pick(centreEvent())?.kind).toBe('body');
  });

  it('does not select the excluded interior of a profile hole', () => {
    const profile = projectedProfile('annulus', undefined, [
      [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 1 },
        { x: -1, y: 1 }
      ]
    ]);
    const { service } = makeService({}, undefined, {
      profiles: () => [profile],
      selectionContext: () => 'profile-command'
    });

    expect(service.pick(centreEvent())).toBeNull();
  });

  it('keeps stacked profiles as distinct select-other candidates', () => {
    const { service } = makeService({}, undefined, {
      profiles: () => [
        projectedProfile('profile-a'),
        projectedProfile('profile-b')
      ],
      selectionContext: () => 'profile-command'
    });

    expect(
      service
        .pickAll(centreEvent())
        .map((candidate) => candidate.region?.profileId)
    ).toEqual(['profile-a', 'profile-b']);
  });
});

describe('topology resolution', () => {
  it('resolves the picked triangle to its exact face', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(
      planeAt(0, {
        bodyId: 'body-1',
        topology: {
          faces: [
            {
              topologyId: 'face-1',
              hash: 7,
              triangleStart: 0,
              triangleCount: 2
            }
          ]
        }
      })
    );
    const { service } = makeService({ bodyGroup });

    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('face');
    expect(pick?.selection).toEqual({
      bodyId: 'body-1',
      kind: 'face',
      topologyId: 'face-1',
      hash: 7
    });
    // A plane facing the camera reports its outward normal in world space.
    expect(pick?.faceNormal?.z).toBeCloseTo(1, 6);
  });

  it('falls back to the whole body when no face covers the triangle', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(
      planeAt(0, {
        bodyId: 'body-1',
        topology: {
          faces: [
            {
              topologyId: 'face-1',
              hash: 7,
              triangleStart: 40,
              triangleCount: 2
            }
          ]
        }
      })
    );
    const { service } = makeService({ bodyGroup });

    expect(service.pick(centreEvent())?.kind).toBe('body');
  });

  it('inherits the body id from an ancestor group', () => {
    const bodyGroup = new THREE.Group();
    const carrier = new THREE.Group();
    carrier.userData = { bodyId: 'body-9' };
    carrier.add(planeAt(0, {}));
    carrier.updateMatrixWorld(true);
    bodyGroup.add(carrier);
    const { service } = makeService({ bodyGroup });

    expect(service.pick(centreEvent())?.selection?.bodyId).toBe('body-9');
  });
});

describe('batched topology edge picking', () => {
  it('resolves a segment hit through the batch ownership map', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(batchedBody('body-batch'));
    const { service } = makeService({ bodyGroup });

    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('edge');
    expect(pick?.selection).toEqual({
      bodyId: 'body-batch',
      kind: 'edge',
      topologyId: 'edge-body-batch',
      hash: 10
    });
  });

  it('deduplicates adjacent segments of one edge for depth cycling', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(batchedBody('body-batch'));
    const { service } = makeService({ bodyGroup });

    expect(service.pickAll(centreEvent())).toHaveLength(1);
  });

  it('keeps distinct batched bodies in near-to-far cycle order', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(batchedBody('far', 0), batchedBody('near', 5));
    const { service } = makeService({ bodyGroup });

    expect(
      service
        .pickAll(centreEvent())
        .map((candidate) => candidate.selection?.bodyId)
    ).toEqual(['near', 'far']);
  });

  it('does not pick a visible batch beneath a hidden body parent', () => {
    const bodyGroup = new THREE.Group();
    const body = batchedBody('hidden');
    body.visible = false;
    bodyGroup.add(body);
    const { service } = makeService({ bodyGroup });

    expect(service.pick(centreEvent())).toBeNull();
  });

  it('keeps edge and face filters correct with a batched edge in front', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(
      planeAt(0, {
        bodyId: 'face-body',
        topology: {
          faces: [
            {
              topologyId: 'face-1',
              hash: 7,
              triangleStart: 0,
              triangleCount: 2
            }
          ]
        }
      }),
      batchedBody('edge-body', 5)
    );

    expect(
      makeService({ bodyGroup }, 'edge').service.pick(centreEvent())?.kind
    ).toBe('edge');
    expect(
      makeService({ bodyGroup }, 'face').service.pick(centreEvent())?.kind
    ).toBe('face');
  });
});

describe('pickAll feeds depth cycling', () => {
  it('returns every body under the pointer nearest first', () => {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(planeAt(0, { bodyId: 'far' }));
    bodyGroup.add(planeAt(5, { bodyId: 'near' }));
    const { service } = makeService({ bodyGroup });

    const all = service.pickAll(centreEvent());
    expect(all.map((candidate) => candidate.selection?.bodyId)).toEqual([
      'near',
      'far'
    ]);
    expect(all[0]!.distance).toBeLessThan(all[1]!.distance);
  });

  it('agrees with pick on the winning candidate', () => {
    const regionGroup = new THREE.Group();
    regionGroup.add(planeAt(0, { region: REGION }));
    const sketchGroup = new THREE.Group();
    sketchGroup.add(planeAt(1, { sketchId: 'sketch-1' }));
    const { service } = makeService({ regionGroup, sketchGroup });

    const first = service.pickAll(centreEvent())[0];
    const picked = service.pick(centreEvent());
    expect(first?.kind).toBe(picked?.kind);
    expect(first?.kind).toBe('region');
  });

  it('is empty when the pointer is over nothing', () => {
    const { service } = makeService();
    expect(service.pickAll(centreEvent())).toEqual([]);
    expect(service.pick(centreEvent())).toBeNull();
  });
});

describe('selection filters narrow what a click can take', () => {
  /** A solid whose triangles resolve to a face, with an edge in front of it. */
  function layered() {
    const bodyGroup = new THREE.Group();
    bodyGroup.add(
      planeAt(0, {
        bodyId: 'body-1',
        topology: {
          faces: [
            {
              topologyId: 'face-1',
              hash: 7,
              triangleStart: 0,
              triangleCount: 2
            }
          ]
        }
      })
    );
    const edge = planeAt(5, {
      bodyId: 'body-1',
      topologyKind: 'edge',
      topologyId: 'edge-1',
      topologyHash: 9
    });
    bodyGroup.add(edge);
    return bodyGroup;
  }

  it('takes the nearest thing of any kind by default', () => {
    const { service } = makeService({ bodyGroup: layered() });
    expect(service.pick(centreEvent())?.kind).toBe('edge');
  });

  it('reaches the face behind an edge when filtering to faces', () => {
    const { service } = makeService({ bodyGroup: layered() }, 'face');
    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('face');
    expect(pick?.selection?.topologyId).toBe('face-1');
  });

  it('takes only the edge when filtering to edges', () => {
    const { service } = makeService({ bodyGroup: layered() }, 'edge');
    const all = service.pickAll(centreEvent());
    expect(all.map((candidate) => candidate.kind)).toEqual(['edge']);
  });

  it('resolves a face to its body rather than rejecting it', () => {
    // A body filter is for grabbing whole solids, so a face click still lands.
    const { service } = makeService({ bodyGroup: layered() }, 'body');
    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('body');
    expect(pick?.selection).toEqual({ bodyId: 'body-1', kind: 'body' });
  });

  it("collapses one body's face and edge into a single body candidate", () => {
    const { service } = makeService({ bodyGroup: layered() }, 'body');
    expect(service.pickAll(centreEvent())).toHaveLength(1);
  });

  it('passes solids through entirely when filtering to sketches', () => {
    const regionGroup = new THREE.Group();
    regionGroup.add(planeAt(-5, { region: REGION }));
    const { service } = makeService(
      { bodyGroup: layered(), regionGroup },
      'sketch'
    );
    // The region is furthest away and still wins: the solids are not competing.
    expect(service.pick(centreEvent())?.kind).toBe('region');
  });

  it('finds nothing when a sketch filter is on and there is no sketch', () => {
    const { service } = makeService({ bodyGroup: layered() }, 'sketch');
    expect(service.pick(centreEvent())).toBeNull();
  });
});
