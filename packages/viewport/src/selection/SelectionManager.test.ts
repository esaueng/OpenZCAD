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
  EDGE_SELECTED_WIDTH
} from '../pick/edges';
import { REGION_HOVER_OPACITY, SelectionManager } from './SelectionManager';

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
  return edge;
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

    manager.setEdgeHover(null);
    expect(edge.material.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(edge.material.linewidth).toBe(EDGE_IDLE_WIDTH);
    expect(edge.material.opacity).toBe(EDGE_IDLE_OPACITY);
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

  it('does no work when the same edge is re-hovered', () => {
    const { manager, renders } = makeManager();
    const edge = makeEdge(false);

    manager.setEdgeHover(edge);
    const after = renders();
    manager.setEdgeHover(edge);
    expect(renders()).toBe(after);
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
