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
import { VIEWPORT_RENDER_ORDER } from '../render/scene';
import { createBodyEdgeOverlay } from '../render/edgeOverlay';

function makeManager(overrides: Partial<{ editable: string[] }> = {}) {
  const bodyGroup = new THREE.Group();
  const objectsByBodyId = new Map<string, THREE.Object3D>();
  const domElement = { style: { cursor: '' } } as unknown as HTMLElement;
  let renders = 0;
  let bodies: BodyRepresentation[] = [];
  const editable = new Set(overrides.editable ?? []);
  let extrudeArmed = false;
  const manager = new SelectionManager({
    bodyGroup,
    objectsByBodyId,
    domElement,
    requestRender: () => {
      renders += 1;
    },
    bodies: () => bodies,
    isEditableBody: (bodyId) => editable.has(bodyId),
    extrudeArmed: () => extrudeArmed
  });
  return {
    manager,
    bodyGroup,
    objectsByBodyId,
    domElement,
    renders: () => renders,
    setBodies: (next: BodyRepresentation[]) => {
      bodies = next;
    },
    setExtrudeArmed: (value: boolean) => {
      extrudeArmed = value;
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

    manager.applyHover(candidate({ kind: 'edge', selection, hit }));
    expect(overlay.hoverEdges.visible).toBe(true);
    expect(overlay.hoverEdges.geometry.instanceCount).toBe(2);
    expect(overlay.hoverEdges.geometry).toBe(hoverGeometry);

    manager.applyHover(null);
    expect(overlay.hoverEdges.visible).toBe(false);
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

  it('lets an armed extrude gizmo claim the cursor', () => {
    const { manager, domElement, setExtrudeArmed } = makeManager();
    setExtrudeArmed(true);
    manager.applyHover(null);
    expect(domElement.style.cursor).toBe('grab');
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

describe('region hover fades', () => {
  function regionMesh(selected = false) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
    );
    mesh.userData = { region: { sketchId: 's' }, regionSelected: selected };
    return mesh;
  }

  it('queues a fade in on hover and a fade out on leave', () => {
    const { manager } = makeManager();
    const mesh = regionMesh();

    manager.setRegionHover(mesh);
    expect(mesh.material.userData.targetOpacity).toBe(REGION_HOVER_OPACITY);
    expect(manager.fadeIns.has(mesh.material)).toBe(true);

    manager.setRegionHover(null);
    expect(mesh.material.userData.targetOpacity).toBe(0);
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
  it('settles a material onto its target and stops tracking it', () => {
    const { manager } = makeManager();
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0
    });
    material.userData.targetOpacity = 0.32;
    manager.fadeIns.add(material);

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
