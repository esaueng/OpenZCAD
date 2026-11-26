import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react';
import * as THREE from 'three';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type BodyTopology,
  type GeometryBodyRepresentation
} from '@openzcad/shared';
import {
  HudLayer,
  type PickCandidate,
  type PickService
} from '@openzcad/viewport';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers
} from '../../lib/assembly/assemblyRuntime';
import { buildAssemblyView } from '../../lib/assembly/assemblyView';
import { AssemblyPlayer } from '../assembly/AssemblyPlayer';
import { AssemblyViewport } from './assemblyViewport';

const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

/** Blade A grounded, blade B on a 0°–35° revolute about the world Z axis. */
function scissors() {
  const manager = new CommandManager(
    createProjectDocument('Scissors', toUserId('user_viewport'))
  );
  for (const name of ['Blade A', 'Blade B'])
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 2, depth: 100 }
      })
    );
  const [a, b] = manager.document.bodyOrder as [BodyId, BodyId];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
        { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
      ]
    })
  );
  manager.execute(
    commandFactories.addAssemblyJoint({
      joint: {
        id: 'joint_pivot',
        name: 'Pivot',
        kind: 'revolute',
        parent: { componentId: 'comp_a', frame: PIVOT },
        child: { componentId: 'comp_b', frame: PIVOT },
        values: [0],
        limits: [{ min: 0, max: 90 }]
      }
    })
  );
  return { document: manager.document, manager, a, b };
}

/**
 * Scissors plus Blade C on its own 0°–90° revolute to Blade A, and an
 * animation that turns both joints: two motions independent of each other.
 */
function twoJoints() {
  const { manager, b } = scissors();
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Blade C',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 2, depth: 100 }
    })
  );
  const c = manager.document.bodyOrder.at(-1) as BodyId;
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        { componentId: 'comp_c', name: 'Blade C', bodyId: c, grounded: false }
      ]
    })
  );
  manager.execute(
    commandFactories.addAssemblyJoint({
      joint: {
        id: 'joint_c',
        name: 'Hinge C',
        kind: 'revolute',
        parent: { componentId: 'comp_a', frame: PIVOT },
        child: { componentId: 'comp_c', frame: PIVOT },
        values: [0],
        limits: [{ min: 0, max: 90 }]
      }
    })
  );
  manager.execute(
    commandFactories.setAssemblyStudy({
      study: {
        id: 'study_both',
        name: 'Both',
        durationS: 2,
        playback: 'once',
        tracks: [
          {
            jointId: 'joint_pivot',
            dof: 0,
            keys: [
              { t: 0, value: 0, easing: 'linear' },
              { t: 2, value: 60, easing: 'linear' }
            ]
          },
          {
            jointId: 'joint_c',
            dof: 0,
            keys: [
              { t: 0, value: 0, easing: 'linear' },
              { t: 2, value: 80, easing: 'linear' }
            ]
          }
        ]
      }
    })
  );
  return { document: manager.document, b };
}

/** Blade B carries an exact Ø4 bore on the axis (40, 0, z), z ∈ [0, 2]. */
const BLADE_B_TOPOLOGY: BodyTopology = {
  faces: [
    {
      topologyId: 'face_bore',
      hash: 7,
      triangleStart: 0,
      triangleCount: 1,
      geometry: {
        surfaceType: 'CYLINDER',
        area: 1,
        center: { x: 40, y: 0, z: 1 },
        axisStart: { x: 40, y: 0, z: 0 },
        axisEnd: { x: 40, y: 0, z: 2 }
      }
    }
  ],
  edges: []
};

function harness(
  b: BodyId,
  pick: (event: PointerEvent | MouseEvent) => PickCandidate | null
) {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  const objects = new Map<string, THREE.Object3D>([[b, new THREE.Object3D()]]);
  const raycaster = new THREE.Raycaster();
  // Client pixels map straight onto world XY, looking down −Z.
  const picker = {
    raycaster,
    pick,
    setRayFromEvent(event: PointerEvent | MouseEvent) {
      raycaster.ray.set(
        new THREE.Vector3(event.clientX, event.clientY, 50),
        new THREE.Vector3(0, 0, -1)
      );
    }
  } as unknown as PickService;
  const buildEvents: string[] = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup'])
    canvas.addEventListener(type, () => buildEvents.push(type), true);
  const viewport = new AssemblyViewport({
    host,
    canvas,
    scene: new THREE.Scene(),
    objectsByBodyId: objects,
    picker,
    camera: () => new THREE.PerspectiveCamera(),
    bodies: () =>
      [
        { bodyId: b, topology: BLADE_B_TOPOLOGY }
      ] as unknown as GeometryBodyRepresentation[],
    worldPerPixelAt: () => 0.01,
    resolution: () => ({ width: 800, height: 600 }),
    requestRender: () => undefined,
    refreshShadowMap: () => undefined,
    clearHover: () => undefined,
    hud: new HudLayer(host)
  });
  const pointer = (
    type: string,
    x: number,
    y: number,
    modifiers: PointerEventInit = {}
  ) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        clientX: x,
        clientY: y,
        ...modifiers
      })
    );
  return { viewport, objects, buildEvents, pointer, host };
}

function onBlade(b: BodyId, point: THREE.Vector3, face = false): PickCandidate {
  return {
    kind: face ? 'face' : 'body',
    distance: 1,
    hit: { point, distance: 1, object: new THREE.Object3D() },
    selection: face
      ? { bodyId: b, kind: 'face', topologyId: 'face_bore' }
      : { bodyId: b, kind: 'body' }
  };
}

const VIEW_RUNTIME = {
  placementOverrides: new Map(),
  selectedJointId: null,
  jointTool: null
};

afterEach(() => {
  cleanup();
  registerAssemblyCommitHandlers(null);
  assemblyRuntime.setActive(false);
  assemblyRuntime.reset();
  document.body.replaceChildren();
});

describe('Assemble viewport', () => {
  it('adds a Ctrl/Command-picked part without starting a drag', () => {
    const { document: doc, b } = scissors();
    assemblyRuntime.setActive(true);
    assemblyRuntime.selectComponent('comp_a');
    const { viewport, pointer } = harness(b, () =>
      onBlade(b, new THREE.Vector3(40, 0, 1))
    );
    viewport.setView(
      buildAssemblyView(doc, { ...VIEW_RUNTIME, overrides: new Map() })
    );
    pointer('pointerdown', 40, 0, { ctrlKey: true });
    pointer('pointermove', 0, 40);
    pointer('pointerup', 0, 40);
    expect(getAssemblyRuntime().selectedComponentIds).toEqual([
      'comp_a',
      'comp_b'
    ]);
    expect(getAssemblyRuntime().overrides.size).toBe(0);
    pointer('pointerdown', 40, 0, { metaKey: true });
    pointer('pointerup', 40, 0);
    expect(getAssemblyRuntime().selectedComponentIds).toEqual(['comp_a']);
    viewport.dispose();
  });

  it('poses a component body by its matrix and restores it after', () => {
    const { document: doc, b } = scissors();
    const { viewport, objects } = harness(b, () => null);
    const view = buildAssemblyView(doc, {
      ...VIEW_RUNTIME,
      overrides: new Map([['joint_pivot', [30]]])
    })!;
    viewport.setView(view);
    const object = objects.get(b)!;
    expect(object.matrixAutoUpdate).toBe(false);
    expect(object.matrix.elements).toEqual(view.matrices.get(b));
    viewport.setView(null);
    expect(object.matrixAutoUpdate).toBe(true);
    expect(object.matrix.equals(new THREE.Matrix4())).toBe(true);
    viewport.dispose();
  });

  it('drags a blade about its pivot as one undo step, out of Build’s reach', () => {
    const { document: doc, b } = scissors();
    const committed: Record<string, number[]>[] = [];
    registerAssemblyCommitHandlers({
      commitPose: (values) => committed.push(values),
      createJoint: () => undefined
    });
    assemblyRuntime.setActive(true);
    const { viewport, buildEvents, pointer } = harness(b, () =>
      onBlade(b, new THREE.Vector3(40, 0, 1))
    );
    viewport.setView(
      buildAssemblyView(doc, { ...VIEW_RUNTIME, overrides: new Map() })
    );
    pointer('pointerdown', 40, 0);
    expect(getAssemblyRuntime().selectedComponentId).toBe('comp_b');
    const a = THREE.MathUtils.degToRad(12.2);
    pointer('pointermove', 40 * Math.cos(a), 40 * Math.sin(a));
    expect(getAssemblyRuntime().overrides.get('joint_pivot')).toEqual([12]);
    const past = THREE.MathUtils.degToRad(120);
    pointer('pointermove', 40 * Math.cos(past), 40 * Math.sin(past));
    expect(getAssemblyRuntime().overrides.get('joint_pivot')).toEqual([90]);
    pointer('pointerup', 40 * Math.cos(past), 40 * Math.sin(past));
    expect(committed).toEqual([{ joint_pivot: [90] }]);
    expect(buildEvents).toEqual([]);
    viewport.dispose();
  });

  it('drags from rest past the player’s preview, saving only the dragged joint (AS06)', () => {
    const { document: doc, b } = twoJoints();
    const committed: Record<string, number[]>[] = [];
    registerAssemblyCommitHandlers({
      commitPose: (values) => committed.push(values),
      createJoint: () => undefined
    });
    assemblyRuntime.setActive(true);
    // The compact sheet's Player, half open over the model, scrubbed to a
    // pose that turns both joints.
    render(createElement(AssemblyPlayer, { assembly: doc.assembly }));
    fireEvent.change(screen.getByRole('slider', { name: 'Position' }), {
      target: { value: '1' }
    });
    expect(Object.fromEntries(getAssemblyRuntime().overrides)).toEqual({
      joint_pivot: [30],
      joint_c: [40]
    });
    const { viewport, pointer } = harness(b, () =>
      onBlade(b, new THREE.Vector3(40, 0, 1))
    );
    viewport.setView(
      buildAssemblyView(doc, { ...VIEW_RUNTIME, overrides: new Map() })
    );
    act(() => {
      pointer('pointerdown', 40, 0);
      const a = THREE.MathUtils.degToRad(12.2);
      pointer('pointermove', 40 * Math.cos(a), 40 * Math.sin(a));
    });
    // The preview is over: Hinge C is back at rest, Pivot follows the drag.
    expect(Object.fromEntries(getAssemblyRuntime().overrides)).toEqual({
      joint_pivot: [12]
    });
    act(() => {
      const a = THREE.MathUtils.degToRad(12.2);
      pointer('pointerup', 40 * Math.cos(a), 40 * Math.sin(a));
    });
    expect(committed).toEqual([{ joint_pivot: [12] }]);
    // The player is back at the start, showing nothing.
    expect(screen.getByRole('slider', { name: 'Position' })).toHaveValue('0');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    viewport.dispose();
  });

  it('never saves the player’s preview, and an edit starts from rest', () => {
    const committed: Record<string, number[]>[] = [];
    registerAssemblyCommitHandlers({
      commitPose: (values) => committed.push(values),
      createJoint: () => undefined
    });
    assemblyRuntime.setActive(true);
    const id = assemblyRuntime.startPreview();
    assemblyRuntime.showPreview(
      id,
      new Map([
        ['joint_pivot', [30]],
        ['joint_c', [40]]
      ])
    );
    assemblyRuntime.commitOverrides();
    expect(committed).toEqual([]);
    assemblyRuntime.setOverride('joint_pivot', [5], 0);
    expect(getAssemblyRuntime().previewId).toBeNull();
    expect(Object.fromEntries(getAssemblyRuntime().overrides)).toEqual({
      joint_pivot: [5]
    });
    // An ended preview shows nothing more.
    expect(assemblyRuntime.showPreview(id, new Map([['joint_c', [40]]]))).toBe(
      false
    );
    assemblyRuntime.commitOverrides();
    expect(committed).toEqual([{ joint_pivot: [5] }]);
  });

  it('picks a joint frame in the component’s modelled coordinates', () => {
    const { document: doc, b } = scissors();
    assemblyRuntime.setActive(true);
    assemblyRuntime.openJointTool('revolute');
    // Blade B turned a quarter turn: its bore at modelled (40, 0) sits at
    // world (0, 40). The hit lands on the bore wall, 2 mm off the axis.
    const view = buildAssemblyView(doc, {
      ...VIEW_RUNTIME,
      jointTool: getAssemblyRuntime().jointTool,
      overrides: new Map([['joint_pivot', [90]]])
    })!;
    const { viewport, pointer } = harness(b, () =>
      onBlade(b, new THREE.Vector3(-2, 40, 1.5), true)
    );
    viewport.setView(view);
    pointer('pointerdown', 0, 40);
    const child = getAssemblyRuntime().jointTool?.child;
    expect(child?.componentId).toBe('comp_b');
    expect(child?.source.kind).toBe('cylinder');
    const { origin, zAxis } = child!.frame;
    expect(origin.x).toBeCloseTo(40, 9);
    expect(origin.y).toBeCloseTo(0, 9);
    expect(origin.z).toBeCloseTo(1.5, 9);
    expect(zAxis.z).toBeCloseTo(1, 12);
    expect(getAssemblyRuntime().jointTool?.step).toBe('parent');
    viewport.dispose();
  });
});
