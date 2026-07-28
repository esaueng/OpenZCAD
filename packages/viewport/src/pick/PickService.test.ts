import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PickService } from './PickService';
import type { SelectionFilter } from '../types';

/**
 * The service only calls `getBoundingClientRect`, so a stub keeps these tests
 * in the node environment alongside the rest of the package.
 */
function stubElement(size = 100): HTMLElement {
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size })
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

interface Groups {
  regionGroup: THREE.Group;
  sketchGroup: THREE.Group;
  bodyGroup: THREE.Group;
}

function makeService(groups: Partial<Groups> = {}, filter?: SelectionFilter) {
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
    filter: filter ? () => filter : undefined
  });
  return { service, regionGroup, sketchGroup, bodyGroup };
}

const REGION = {
  sketchId: 'sketch-1',
  regionFingerprint: 42,
  samplePoint: { x: 0, y: 0 },
  area: 100
};

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
    bodyGroup.add(planeAt(5, { bodyId: 'body-1' }));
    const { service } = makeService({ regionGroup, bodyGroup });

    const pick = service.pick(centreEvent());
    expect(pick?.kind).toBe('body');
    expect(pick?.selection).toEqual({ bodyId: 'body-1', kind: 'body' });
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
            { topologyId: 'face-1', hash: 7, triangleStart: 0, triangleCount: 2 }
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

  it('collapses one body\'s face and edge into a single body candidate', () => {
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
