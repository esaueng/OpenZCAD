import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import type { PickCandidate } from '../pick/PickService';
import {
  EDGE_HOVER_COLOR,
  EDGE_IDLE_COLOR,
  EDGE_IDLE_OPACITY,
  EDGE_IDLE_WIDTH,
  EDGE_SELECTED_COLOR,
  EDGE_SELECTED_WIDTH,
  EDGE_WIREFRAME_COLOR
} from '../pick/edges';
import {
  REGION_HOVER_OPACITY,
  REGION_SELECTED_OPACITY,
  SelectionManager
} from './SelectionManager';
import { easeToward } from '../motion';
import { VIEWPORT_RENDER_ORDER } from '../render/scene';
import { createBodyEdgeOverlay } from '../render/edgeOverlay';

function makeManager(overrides: Partial<{ editable: string[] }> = {}) {
  const bodyGroup = new THREE.Group();
  const objectsByBodyId = new Map<string, THREE.Object3D>();
  const domElement = { style: { cursor: '' } } as unknown as HTMLElement;
  let renders = 0;
  let bodies: BodyRepresentation[] = [];
  const editable = new Set(overrides.editable ?? []);
  const manager = new SelectionManager({
    bodyGroup,
    objectsByBodyId,
    domElement,
    requestRender: () => {
      renders += 1;
    },
    bodies: () => bodies,
    isEditableBody: (bodyId) => editable.has(bodyId)
  });
  return {
    manager,
    bodyGroup,
    objectsByBodyId,
    domElement,
    renders: () => renders,
    setBodies: (next: BodyRepresentation[]) => {
      bodies = next;
    }
  };
}

function makeEdge(selected: boolean): Line2 {
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 1, 0, 0]);
  const edge = new Line2(geometry, new LineMaterial({ linewidth: 1 }));
  edge.userData = { selected };
  edge.renderOrder = selected
    ? VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY
    : VIEWPORT_RENDER_ORDER.BODY_EDGE;
  return edge;
}

function makeBatchedEdge(smoothContinuation = false) {
  const bodyId = toBodyId('body-batch');
  const edges = [
    {
      topologyId: 'edge-batch',
      hash: 42,
      vertexIds: [1, 2] as [number, number],
      points: [0, 0, 0, 1, 0, 0, 2, 0, 0]
    },
    ...(smoothContinuation
      ? [
          {
            topologyId: 'edge-next',
            hash: 43,
            vertexIds: [2, 3] as [number, number],
            points: [2, 0, 0, 3, 0, 0]
          }
        ]
      : [])
  ];
  const topology = {
    faces: [],
    edges
  };
  const overlay = createBodyEdgeOverlay(
    {
      bodyId,
      topology
    },
    { width: 100, height: 100 }
  );
  const selection = {
    bodyId,
    kind: 'edge' as const,
    topologyId: 'edge-batch',
    hash: 42
  };
  const hit = {
    object: overlay.idleEdges,
    faceIndex: 0
  } as unknown as PickCandidate['hit'];
  return { bodyId, overlay, selection, hit, topology };
}

function candidate(partial: Partial<PickCandidate>): PickCandidate {
  return {
    kind: 'body',
    distance: 1,
    hit: { object: new THREE.Object3D() } as unknown as PickCandidate['hit'],
    selection: null,
    ...partial
  };
}

describe('edge hover styling', () => {
  it('highlights an unselected edge and restores it on leave', () => {
    const { manager } = makeManager();
    const edge = makeEdge(false);

    manager.setEdgeHover(edge);
    expect(edge.material.color.getHex()).toBe(EDGE_HOVER_COLOR);
    expect(edge.material.opacity).toBe(1);
    expect(edge.renderOrder).toBe(VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT);

    manager.setEdgeHover(null);
    expect(edge.material.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(edge.material.linewidth).toBe(EDGE_IDLE_WIDTH);
    expect(edge.material.opacity).toBe(EDGE_IDLE_OPACITY);
    expect(edge.renderOrder).toBe(VIEWPORT_RENDER_ORDER.BODY_EDGE);
  });

  it('leaves a selected edge looking selected while hovered', () => {
    const { manager } = makeManager();
    const edge = makeEdge(true);

    manager.setEdgeHover(edge);
    expect(edge.material.color.getHex()).not.toBe(EDGE_HOVER_COLOR);

    manager.setEdgeHover(null);
    expect(edge.material.color.getHex()).toBe(EDGE_SELECTED_COLOR);
    expect(edge.material.linewidth).toBe(EDGE_SELECTED_WIDTH);
    expect(edge.material.opacity).toBe(1);
  });

  it('restores the previous edge when hover moves straight to another', () => {
    const { manager } = makeManager();
    const first = makeEdge(false);
    const second = makeEdge(false);

    manager.setEdgeHover(first);
    manager.setEdgeHover(second);
    expect(first.material.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(second.material.color.getHex()).toBe(EDGE_HOVER_COLOR);
  });

  it('restores wireframe contrast after edge hover', () => {
    const { manager } = makeManager();
    const edge = makeEdge(false);
    edge.userData.displayMode = 'wireframe';

    manager.setEdgeHover(edge);
    manager.setEdgeHover(null);

    expect(edge.material.color.getHex()).toBe(EDGE_WIREFRAME_COLOR);
    expect(edge.material.opacity).toBe(EDGE_IDLE_OPACITY);
  });

  it('does no work when the same edge is re-hovered', () => {
    const { manager, renders } = makeManager();
    const edge = makeEdge(false);

    manager.setEdgeHover(edge);
    const after = renders();
    manager.setEdgeHover(edge);
    expect(renders()).toBe(after);
  });

  it('moves the reusable batched hover overlay to a picked segment', () => {
    const { manager } = makeManager();
    const { overlay, selection, hit } = makeBatchedEdge();
    const hoverGeometry = overlay.hoverEdges.geometry;

    // Hover is a cut: applyHover itself puts the batch on screen at full
    // presence, with no render-loop step in between, and takes it off again.
    manager.applyHover(candidate({ kind: 'edge', selection, hit }));
    expect(overlay.hoverEdges.visible).toBe(true);
    expect(overlay.hoverEdges.material.opacity).toBe(1);
    expect(overlay.hoverEdges.geometry.instanceCount).toBe(2);
    expect(overlay.hoverEdges.geometry).toBe(hoverGeometry);

    manager.applyHover(null);
    expect(overlay.hoverEdges.visible).toBe(false);
    expect(overlay.hoverEdges.material.opacity).toBe(0);
  });

  it('computes a smooth run only when the edge candidate changes', () => {
    const { manager, renders, setBodies } = makeManager();
    const { bodyId, overlay, selection, hit, topology } = makeBatchedEdge(true);
    setBodies([{ bodyId, topology } as unknown as BodyRepresentation]);

    manager.applyHover(candidate({ kind: 'edge', selection, hit }));
    expect(overlay.hoverEdges.geometry.instanceCount).toBe(3);

    const afterFirstCandidate = renders();
    manager.applyHover(candidate({ kind: 'edge', selection, hit }));
    expect(renders()).toBe(afterFirstCandidate);
  });

  it('does not duplicate a selected edge with the batched hover overlay', () => {
    const { manager } = makeManager();
    const { overlay, selection, hit } = makeBatchedEdge();
    overlay.setSelected([selection]);

    manager.applyHover(candidate({ kind: 'edge', selection, hit }));
    expect(overlay.selectedEdges.visible).toBe(true);
    expect(overlay.hoverEdges.visible).toBe(false);
  });
});

describe('cursor feedback', () => {
  it('offers a grab cursor on a directly editable face', () => {
    const { manager, domElement } = makeManager({ editable: ['body-1'] });
    manager.applyHover(
      candidate({
        kind: 'face',
        selection: { bodyId: 'body-1', kind: 'face', topologyId: 'f1' }
      } as Partial<PickCandidate>)
    );
    expect(domElement.style.cursor).toBe('grab');
  });

  it('offers a pointer cursor on a face that is not directly editable', () => {
    const { manager, domElement } = makeManager();
    manager.applyHover(
      candidate({
        kind: 'face',
        selection: { bodyId: 'body-2', kind: 'face', topologyId: 'f1' }
      } as Partial<PickCandidate>)
    );
    expect(domElement.style.cursor).toBe('pointer');
  });

  it('clears the cursor over empty space', () => {
    const { manager, domElement } = makeManager();
    manager.applyHover(
      candidate({ selection: { bodyId: toBodyId('b'), kind: 'body' } })
    );
    expect(domElement.style.cursor).toBe('pointer');
    manager.applyHover(null);
    expect(domElement.style.cursor).toBe('');
  });

  /**
   * This manager is not the only thing that writes the canvas cursor: the
   * viewer sets `grab` over a move-gizmo handle and over a direct-edit
   * handle, and the gesture router saves and restores the cursor around a
   * captured drag. A cache of "what I last wrote" is stale the instant any of
   * them writes, and the next hover that happens to agree with the stale
   * value then skips its own write — leaving the other writer's cursor on
   * screen for as long as the pointer stays over things that agree with it.
   */
  it('corrects a cursor another writer left on the canvas', () => {
    const { manager, domElement } = makeManager();
    // Hover empty space, so the cache reads ''.
    manager.applyHover(null);
    expect(domElement.style.cursor).toBe('');

    // The move gizmo claims the pointer and writes `grab` straight to the
    // canvas, exactly as the viewer does when a handle is under the pointer.
    domElement.style.cursor = 'grab';

    // The pointer moves off the handle onto empty space again. The cursor has
    // to come back, even though nothing changed as far as the cache knows.
    manager.applyHover(null);
    expect(domElement.style.cursor).toBe('');
  });

  it('still skips the write when the canvas already agrees', () => {
    const { manager, domElement } = makeManager({ editable: ['body-1'] });
    const face = candidate({
      kind: 'face',
      selection: { bodyId: 'body-1', kind: 'face', topologyId: 'f1' }
    } as Partial<PickCandidate>);
    manager.applyHover(face);
    expect(domElement.style.cursor).toBe('grab');

    // Sweeping across a dense face still writes nothing per frame: the point
    // of the cache is that a hover that changes nothing costs nothing.
    let writes = 0;
    Object.defineProperty(domElement.style, 'cursor', {
      get: () => 'grab',
      set: () => {
        writes += 1;
      },
      configurable: true
    });
    manager.applyHover(face);
    manager.applyHover(face);
    expect(writes).toBe(0);
  });
});

/**
 * The viewer used to run a second copy of this same loop over this same set
 * in the same frame, so every registered fade played at double speed and the
 * restore below fired only when the viewer's pass — rather than this one —
 * happened to be the one that landed the value on its target.
 */
describe('the fade set', () => {
  function fading(opacity = 0) {
    return new THREE.MeshBasicMaterial({ transparent: true, opacity });
  }

  it('cuts a registered material onto its target in the first step', () => {
    const { manager } = makeManager();
    const material = fading();
    material.userData.targetOpacity = 0.32;
    manager.fadeIns.add(material);
    expect(manager.isSettling).toBe(true);

    // Even a frame with no elapsed time lands it: a cut does not read dt.
    manager.step(0);

    expect(material.opacity).toBe(0.32);
    expect(manager.fadeIns.size).toBe(0);
    expect(manager.isSettling).toBe(false);
  });

  it('eases a material registered with easeOpacity once per step, not twice', () => {
    const { manager } = makeManager();
    const material = manager.easeOpacity(fading());
    material.userData.targetOpacity = 1;
    manager.fadeIns.add(material);

    manager.step(0.016);
    const afterOne = material.opacity;
    manager.step(0.016);
    const afterTwo = material.opacity;

    expect(afterOne).toBeCloseTo(easeToward(0, 1, 16), 6);
    expect(afterTwo).toBeCloseTo(easeToward(afterOne, 1, 16), 6);
  });

  it('takes a settled material back out of the transparent pass', () => {
    const { manager } = makeManager();
    // What leaving sketch mode registers: a body that was receded, fading
    // back to the fully opaque state it started in.
    const material = manager.easeOpacity(fading(0.35));
    material.userData.targetOpacity = 1;
    material.userData.restoreOpaque = true;
    const version = material.version;
    manager.fadeIns.add(material);

    for (let frame = 0; frame < 200 && manager.fadeIns.size > 0; frame += 1) {
      manager.step(0.016);
    }

    expect(manager.fadeIns.size).toBe(0);
    expect(material.opacity).toBe(1);
    // Left transparent, the body stays in depth-sorted rendering for the rest
    // of the session and sorts against whatever is behind it.
    expect(material.transparent).toBe(false);
    expect(material.userData.restoreOpaque).toBeUndefined();
    // `needsUpdate` is write-only on a three.js material; the version bump is
    // what it does, and what makes the renderer recompile the program.
    expect(material.version).toBeGreaterThan(version);
  });

  it('leaves a material alone that never asked to go back to opaque', () => {
    const { manager } = makeManager();
    const material = fading();
    material.userData.targetOpacity = 1;
    manager.fadeIns.add(material);

    for (let frame = 0; frame < 200 && manager.fadeIns.size > 0; frame += 1) {
      manager.step(0.016);
    }

    expect(material.transparent).toBe(true);
  });
});

describe('body emissive is reserved for whole-body picks', () => {
  function bodyMesh(bodyId: string) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial()
    );
    mesh.userData = { bodyId };
    return mesh;
  }

  it('lifts the emissive for a body pick and drops it again', () => {
    const { manager, bodyGroup } = makeManager();
    const mesh = bodyMesh('body-1');
    bodyGroup.add(mesh);

    manager.applyHover(
      candidate({ selection: { bodyId: toBodyId('body-1'), kind: 'body' } })
    );
    expect(mesh.material.emissive.getHex()).not.toBe(0);

    manager.applyHover(null);
    expect(mesh.material.emissive.getHex()).toBe(0);
  });

  it('leaves the emissive alone for a face pick, which has its own overlay', () => {
    const { manager, bodyGroup } = makeManager();
    const mesh = bodyMesh('body-1');
    bodyGroup.add(mesh);

    manager.applyHover(
      candidate({
        kind: 'face',
        selection: { bodyId: 'body-1', kind: 'face', topologyId: 'f1' }
      } as Partial<PickCandidate>)
    );
    expect(mesh.material.emissive.getHex()).toBe(0);
  });
});

describe('face hover overlay', () => {
  it('uses shaded material and shares the body render buffers', () => {
    const { manager, objectsByBodyId, setBodies } = makeManager();
    const bodyId = toBodyId('body-face');
    const sourceGeometry = new THREE.BufferGeometry();
    const position = new THREE.Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      3
    );
    const normal = new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      3
    );
    sourceGeometry.setAttribute('position', position);
    sourceGeometry.setAttribute('normal', normal);
    sourceGeometry.setIndex([0, 1, 2]);
    const object = new THREE.Mesh(
      sourceGeometry,
      new THREE.MeshPhongMaterial()
    );
    objectsByBodyId.set(bodyId, object);
    setBodies([
      {
        bodyId,
        topology: {
          faces: [
            {
              topologyId: 'face-a',
              hash: 101,
              triangleStart: 0,
              triangleCount: 1
            }
          ],
          edges: []
        }
      } as unknown as BodyRepresentation
    ]);

    manager.setHoverFace({
      bodyId,
      kind: 'face',
      topologyId: 'face-a'
    });

    expect(manager.hoverFaceMesh.material).toBeInstanceOf(
      THREE.MeshLambertMaterial
    );
    expect(manager.hoverFaceMesh.material.toneMapped).toBe(false);
    expect(manager.hoverFaceMesh.geometry.getAttribute('position')).toBe(
      position
    );
    expect(manager.hoverFaceMesh.geometry.getAttribute('normal')).toBe(normal);
    expect(manager.hoverHiddenFaceMesh.geometry.getAttribute('position')).toBe(
      position
    );
    expect(manager.hoverHiddenFaceMesh.geometry.getAttribute('normal')).toBe(
      normal
    );
    expect(manager.hoverHiddenFaceMesh.material.depthFunc).toBe(
      THREE.GreaterDepth
    );
    expect(manager.hoverHiddenFaceMesh.material.depthWrite).toBe(false);
    expect(manager.hoverHiddenFaceMesh.material).toBeInstanceOf(
      THREE.MeshBasicMaterial
    );
    expect(manager.hoverHiddenFaceMesh.material.opacity).toBe(0);

    manager.step(1);
    expect(manager.hoverHiddenFaceMesh.material.opacity).toBeGreaterThan(0);
    expect(manager.hoverHiddenFaceMesh.material.opacity).toBeLessThan(
      manager.hoverFaceMesh.material.opacity
    );
  });

  it('cuts the film on and off with nothing left to settle when x-ray is off', () => {
    const { manager, objectsByBodyId, setBodies, renders } = makeManager();
    const bodyId = toBodyId('body-face-cut');
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    sourceGeometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    sourceGeometry.setIndex([0, 1, 2]);
    const object = new THREE.Mesh(
      sourceGeometry,
      new THREE.MeshPhongMaterial()
    );
    objectsByBodyId.set(bodyId, object);
    setBodies([
      {
        bodyId,
        topology: {
          faces: [
            {
              topologyId: 'face-a',
              hash: 101,
              triangleStart: 0,
              triangleCount: 1
            }
          ],
          edges: []
        }
      } as unknown as BodyRepresentation
    ]);
    manager.setXrayEnabled(false);

    // The change asks for a render, and the film is already at rest for it:
    // no ramp is left to keep the loop awake after that one frame.
    let before = renders();
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });
    expect(renders()).toBeGreaterThan(before);
    const film = manager.hoverFaceMesh;
    expect(film.visible).toBe(true);
    expect(film.material.opacity).toBeCloseTo(0.3, 5);
    expect(manager.isSettling).toBe(false);

    before = renders();
    manager.setHoverFace(null);
    expect(renders()).toBeGreaterThan(before);
    expect(film.visible).toBe(false);
    expect(film.material.opacity).toBe(0);
    expect(film.parent).toBeNull();
    expect(manager.isSettling).toBe(false);
  });

  it('suppresses the hidden hover pass while sketch solids are receded', () => {
    const { manager, objectsByBodyId, setBodies } = makeManager();
    const bodyId = toBodyId('body-face-sketch');
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    sourceGeometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
    );
    sourceGeometry.setIndex([0, 1, 2]);
    objectsByBodyId.set(
      bodyId,
      new THREE.Mesh(sourceGeometry, new THREE.MeshPhongMaterial())
    );
    setBodies([
      {
        bodyId,
        topology: {
          faces: [
            {
              topologyId: 'face-a',
              hash: 101,
              triangleStart: 0,
              triangleCount: 1
            }
          ],
          edges: []
        }
      } as unknown as BodyRepresentation
    ]);

    manager.setXrayEnabled(false);
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });

    expect(manager.hoverFaceMesh.visible).toBe(true);
    expect(manager.hoverHiddenFaceMesh.visible).toBe(false);
  });
});

describe('face hover cross-fade on slow frames', () => {
  it('cuts a face film on in the frame it is entered, even on a 400 ms frame', () => {
    const { manager, objectsByBodyId, setBodies } = makeManager();
    const bodyId = toBodyId('body-crossfade');
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
        3
      )
    );
    sourceGeometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(
        [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        3
      )
    );
    sourceGeometry.setIndex([0, 1, 2, 3, 4, 5]);
    objectsByBodyId.set(
      bodyId,
      new THREE.Mesh(sourceGeometry, new THREE.MeshPhongMaterial())
    );
    setBodies([
      {
        bodyId,
        topology: {
          faces: [
            {
              topologyId: 'face-a',
              hash: 1,
              triangleStart: 0,
              triangleCount: 1
            },
            {
              topologyId: 'face-b',
              hash: 2,
              triangleStart: 1,
              triangleCount: 1
            }
          ],
          edges: []
        }
      } as unknown as BodyRepresentation
    ]);

    // face-a's x-ray pass is still rising, so the render loop is already
    // running on real elapsed time when the pointer moves on to face-b.
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });
    const outgoing = manager.hoverFaceMesh;
    expect(outgoing.material.opacity).toBeCloseTo(0.3, 5);
    manager.step(0.4);
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-b' });
    const incoming = manager.hoverFaceMesh;
    expect(incoming).not.toBe(outgoing);
    // Both halves of the hop land before any frame is stepped: the old film
    // is off and detached, the new one at its resting opacity.
    expect(incoming.material.opacity).toBeCloseTo(0.3, 5);
    expect(incoming.visible).toBe(true);
    expect(outgoing.material.opacity).toBe(0);
    expect(outgoing.visible).toBe(false);
    expect(outgoing.parent).toBeNull();

    // Only the two x-ray passes are left moving, and they land on the next
    // slow frames without the film itself changing.
    expect(manager.isSettling).toBe(true);
    manager.step(0.4);
    manager.step(0.4);
    manager.step(0.4);
    expect(manager.isSettling).toBe(false);
    expect(incoming.material.opacity).toBeCloseTo(0.3, 5);
  });

  it('lets the x-ray pass begin visibly when it returns on a slow frame', () => {
    const { manager, objectsByBodyId, setBodies } = makeManager();
    const bodyId = toBodyId('body-xray');
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
        3
      )
    );
    sourceGeometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(
        [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        3
      )
    );
    sourceGeometry.setIndex([0, 1, 2, 3, 4, 5]);
    objectsByBodyId.set(
      bodyId,
      new THREE.Mesh(sourceGeometry, new THREE.MeshPhongMaterial())
    );
    setBodies([
      {
        bodyId,
        topology: {
          faces: [
            {
              topologyId: 'face-a',
              hash: 1,
              triangleStart: 0,
              triangleCount: 1
            },
            {
              topologyId: 'face-b',
              hash: 2,
              triangleStart: 1,
              triangleCount: 1
            }
          ],
          edges: []
        }
      } as unknown as BodyRepresentation
    ]);

    manager.setXrayEnabled(false);
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });
    manager.step(0.4);
    manager.step(0.4);
    const hidden = manager.hoverHiddenFaceMesh.material;
    expect(hidden.opacity).toBe(0);

    // Leaving sketch mode turns x-ray back on for the film already resting
    // under the pointer: a new target for its hidden pass, so its first step
    // is capped and the pass is seen to fade in rather than pop.
    manager.setXrayEnabled(true);
    manager.step(0.4);
    const first = hidden.opacity;
    expect(first).toBeGreaterThan(0);
    manager.step(0.4);
    expect(hidden.opacity).toBeGreaterThan(first);
    expect(manager.isSettling).toBe(false);
  });
});

describe('region hover fades', () => {
  function regionMesh(selected = false) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
    );
    mesh.userData = { region: { sketchId: 's' }, regionSelected: selected };
    return mesh;
  }

  it('cuts the hover fill on and off in the first step after the change', () => {
    const { manager, renders } = makeManager();
    const mesh = regionMesh();

    const before = renders();
    manager.setRegionHover(mesh);
    expect(renders()).toBe(before + 1);
    expect(mesh.material.userData.targetOpacity).toBe(REGION_HOVER_OPACITY);
    manager.step(0.016);
    expect(mesh.material.opacity).toBe(REGION_HOVER_OPACITY);
    expect(manager.isSettling).toBe(false);

    manager.setRegionHover(null);
    expect(mesh.material.userData.targetOpacity).toBe(0);
    manager.step(0.016);
    expect(mesh.material.opacity).toBe(0);
    expect(manager.isSettling).toBe(false);
  });

  it('does not fade a region that is already selected', () => {
    const { manager } = makeManager();
    const mesh = regionMesh(true);

    manager.setRegionHover(mesh);
    expect(manager.fadeIns.has(mesh.material)).toBe(false);
  });

  it('updates persistent selection without rebuilding the region mesh', () => {
    const { manager } = makeManager();
    const mesh = regionMesh();
    const geometry = mesh.geometry;

    manager.updateRegionState(mesh, true, 0.08);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.userData.regionSelected).toBe(true);
    expect(mesh.material.opacity).toBe(REGION_SELECTED_OPACITY);

    manager.setRegionHover(mesh);
    manager.updateRegionState(mesh, false, 0.08);
    expect(mesh.material.opacity).toBe(REGION_HOVER_OPACITY);
  });

  it('lights every companion of a hovered region and drops them together', () => {
    const { manager } = makeManager();
    const glyph = regionMesh();
    const sibling = regionMesh();
    const selectedSibling = regionMesh(true);
    for (const mesh of [glyph, sibling, selectedSibling]) {
      mesh.userData.regionCompanions = [glyph, sibling, selectedSibling];
    }

    manager.setRegionHover(sibling);
    expect(glyph.material.userData.targetOpacity).toBe(REGION_HOVER_OPACITY);
    expect(sibling.material.userData.targetOpacity).toBe(REGION_HOVER_OPACITY);
    expect(manager.fadeIns.has(selectedSibling.material)).toBe(false);
    // A selection sync while hovered keeps the companion lit.
    manager.updateRegionState(glyph, false, 0.08);
    expect(glyph.material.opacity).toBe(REGION_HOVER_OPACITY);

    manager.setRegionHover(null);
    expect(glyph.material.userData.targetOpacity).toBe(0.08);
    expect(sibling.material.userData.targetOpacity).toBe(0);
  });

  it('only draws the duplicate region boundary for hover or selection', () => {
    const { manager } = makeManager();
    const mesh = regionMesh();
    const boundary = makeEdge(false);
    mesh.userData.regionBoundaries = [boundary];

    manager.updateRegionState(mesh, false, 0.08);
    expect(boundary.visible).toBe(false);

    manager.setRegionHover(mesh);
    expect(boundary.visible).toBe(true);
    expect(boundary.renderOrder).toBe(VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT);

    manager.updateRegionState(mesh, true, 0.08);
    expect(boundary.visible).toBe(true);
    expect(boundary.renderOrder).toBe(VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY);
  });
});

describe('fade stepping', () => {
  it('settles an eased material onto its target and stops tracking it', () => {
    const { manager } = makeManager();
    const material = manager.easeOpacity(
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0
      })
    );
    material.userData.targetOpacity = 0.32;
    manager.fadeIns.add(material);

    manager.step(0.05);
    expect(material.opacity).toBeGreaterThan(0);
    expect(material.opacity).toBeLessThan(0.32);
    // Long enough for the exponential ease to land inside the epsilon.
    for (let i = 0; i < 40; i += 1) {
      manager.step(0.05);
    }
    expect(material.opacity).toBe(0.32);
    expect(manager.fadeIns.size).toBe(0);
  });

  it('reports settling until every overlay has arrived', () => {
    const { manager } = makeManager();
    expect(manager.isSettling).toBe(false);

    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0
    });
    material.userData.targetOpacity = 0.32;
    manager.fadeIns.add(material);
    expect(manager.isSettling).toBe(true);
  });
});

describe('rebuild reset', () => {
  it('drops hover state that points at disposed objects', () => {
    const { manager } = makeManager();
    manager.setEdgeHover(makeEdge(false));
    manager.hoveredBodyId = 'body-1';
    manager.fadeIns.add(new THREE.MeshBasicMaterial());

    manager.resetForRebuild();

    expect(manager.hoveredEdge).toBeNull();
    expect(manager.hoveredBodyId).toBeNull();
    expect(manager.fadeIns.size).toBe(0);
    expect(manager.hoverFaceMesh.visible).toBe(false);
  });
});

describe('face hover hop', () => {
  function threeFaceBody() {
    const { manager, objectsByBodyId, setBodies } = makeManager();
    const bodyId = toBodyId('body-three-face');
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 1, 1, 0, 2, 0, 0, 3, 0,
          0, 2, 1, 0
        ],
        3
      )
    );
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(
        [
          0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
          1, 0, 0, 1
        ],
        3
      )
    );
    geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const object = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial());
    objectsByBodyId.set(bodyId, object);
    setBodies([
      {
        bodyId,
        topology: {
          faces: ['face-a', 'face-b', 'face-c'].map(
            (topologyId, triangleStart) => ({
              topologyId,
              hash: triangleStart + 1,
              triangleStart,
              triangleCount: 1
            })
          ),
          edges: []
        }
      } as unknown as BodyRepresentation
    ]);
    return { manager, bodyId, object };
  }

  const settle = (manager: SelectionManager) => {
    for (let frame = 0; frame < 120 && manager.isSettling; frame += 1) {
      manager.step(0.016);
    }
    expect(manager.isSettling).toBe(false);
  };

  const attachedFaceSlots = (object: THREE.Object3D) =>
    object.children.filter(
      (
        child
      ): child is THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> =>
        child instanceof THREE.Mesh &&
        child.userData.hoverFaceLayer === 'visible'
    );

  const attachedHiddenSlots = (object: THREE.Object3D) =>
    object.children.filter(
      (child) =>
        child instanceof THREE.Mesh &&
        child.userData.hoverFaceLayer === 'hidden'
    );

  const hoverFaceKey = (mesh: THREE.Object3D) =>
    String(mesh.userData.hoverFaceKey ?? '');

  it('cuts between neighbours in one frame, then releases the old slot', () => {
    const { manager, bodyId, object } = threeFaceBody();

    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });
    settle(manager);
    const oldMesh = manager.hoverFaceMesh;
    const oldHidden = manager.hoverHiddenFaceMesh;
    const restingHidden = oldHidden.material.opacity;
    const oldGeometry = oldMesh.geometry;
    let oldGeometryDisposed = false;
    oldGeometry.addEventListener('dispose', () => {
      oldGeometryDisposed = true;
    });

    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-b' });
    expect(manager.hoverFaceMesh).not.toBe(oldMesh);

    // No frame has been stepped: one film is on screen, the new one, already
    // at its resting opacity. There is no frame showing both.
    expect(attachedFaceSlots(object)).toEqual([manager.hoverFaceMesh]);
    expect(manager.hoverFaceMesh.material.opacity).toBeCloseTo(0.3, 5);
    expect(oldMesh.material.opacity).toBe(0);

    // The old x-ray pass is what keeps the slot (and the loop) alive: it
    // fades out over the next frames instead of popping off behind the solid.
    expect(manager.isSettling).toBe(true);
    manager.step(0.016);
    expect(oldHidden.parent).toBe(object);
    expect(oldHidden.material.opacity).toBeGreaterThan(0);
    expect(oldHidden.material.opacity).toBeLessThan(restingHidden);
    expect(manager.hoverFaceMesh.material.opacity).toBeCloseTo(0.3, 5);

    settle(manager);
    expect(attachedFaceSlots(object)).toEqual([manager.hoverFaceMesh]);
    expect(hoverFaceKey(manager.hoverFaceMesh)).toBe(`${bodyId}:face-b`);
    expect(manager.hoverFaceMesh.material.opacity).toBeCloseTo(0.3, 5);
    expect(oldGeometryDisposed).toBe(true);
    expect(oldMesh.parent).toBeNull();
    expect(oldHidden.parent).toBeNull();
  });

  it('bounds an interrupted sweep to two slots and drops the oldest face', () => {
    const { manager, bodyId, object } = threeFaceBody();

    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });
    settle(manager);
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-b' });
    manager.step(0.016);
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-c' });
    manager.step(0.016);

    // face-a's slot was taken over for face-c; face-b's x-ray pass is the
    // only one still fading out, and only face-c has a film on screen.
    expect(attachedHiddenSlots(object).map(hoverFaceKey).sort()).toEqual([
      `${bodyId}:face-b`,
      `${bodyId}:face-c`
    ]);
    expect(attachedFaceSlots(object).map(hoverFaceKey)).toEqual([
      `${bodyId}:face-c`
    ]);
    settle(manager);
    expect(attachedFaceSlots(object).map(hoverFaceKey)).toEqual([
      `${bodyId}:face-c`
    ]);
    expect(attachedHiddenSlots(object).map(hoverFaceKey)).toEqual([
      `${bodyId}:face-c`
    ]);
  });

  it('detaches and releases both slots on rebuild reset', () => {
    const { manager, bodyId, object } = threeFaceBody();
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });
    settle(manager);
    // The film being left is detached the moment it cuts off; its geometry
    // still belongs to the slot until the slot is released.
    const leftFilm = manager.hoverFaceMesh;
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-b' });
    manager.step(0.016);
    const attached = [
      leftFilm,
      ...object.children.filter(
        (child) => child.userData.hoverFaceSlot !== undefined
      )
    ] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>[];
    let disposedGeometryCount = 0;
    let disposedMaterialCount = 0;
    for (const mesh of attached) {
      mesh.geometry.addEventListener('dispose', () => {
        disposedGeometryCount += 1;
      });
      mesh.material.addEventListener('dispose', () => {
        disposedMaterialCount += 1;
      });
    }

    manager.resetForRebuild();

    expect(attached).toHaveLength(4);
    expect(disposedGeometryCount).toBe(4);
    expect(disposedMaterialCount).toBe(0);
    expect(attached.every((mesh) => mesh.parent === null)).toBe(true);
    expect(attachedFaceSlots(object)).toHaveLength(0);
    expect(manager.isSettling).toBe(false);

    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-c' });
    settle(manager);
    expect(attachedFaceSlots(object)).toEqual([manager.hoverFaceMesh]);
    expect(hoverFaceKey(manager.hoverFaceMesh)).toBe(`${bodyId}:face-c`);
  });

  it('disposes every slot resource even while an x-ray pass fades out', () => {
    const { manager, bodyId, object } = threeFaceBody();
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-a' });
    settle(manager);
    // The film being left is detached the moment it cuts off; its geometry
    // still belongs to the slot until the slot is released.
    const leftFilm = manager.hoverFaceMesh;
    manager.setHoverFace({ bodyId, kind: 'face', topologyId: 'face-b' });
    manager.step(0.016);
    const attached = [
      leftFilm,
      ...object.children.filter(
        (child) => child.userData.hoverFaceSlot !== undefined
      )
    ] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>[];
    let disposedGeometryCount = 0;
    let disposedMaterialCount = 0;
    for (const mesh of attached) {
      mesh.geometry.addEventListener('dispose', () => {
        disposedGeometryCount += 1;
      });
      mesh.material.addEventListener('dispose', () => {
        disposedMaterialCount += 1;
      });
    }

    manager.dispose();

    expect(attached).toHaveLength(4);
    expect(disposedGeometryCount).toBe(4);
    expect(disposedMaterialCount).toBe(4);
    expect(attached.every((mesh) => mesh.parent === null)).toBe(true);
    expect(manager.isSettling).toBe(false);
  });
});
