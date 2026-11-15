import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  solveAssembly,
  toUserId,
  transformToMatrix4,
  type AssemblyFrame,
  type BodyId
} from '@openzcad/shared';
import { buildAssemblyView } from './assemblyView';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers
} from './assemblyRuntime';
import {
  beginExplodeDrag,
  chooseExplodeAxis,
  formatExplodeDragValue,
  readExplodeDrag
} from './explodeDrag';

/**
 * AS03 exploded view in the web layer: the view model shows stored (or
 * dragged) offsets only while exploded, the drag follows the world axis the
 * pointer moves along and snaps, and the runtime commits one drag as one
 * command.
 */
const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function hinge() {
  const manager = new CommandManager(
    createProjectDocument('Hinge', toUserId('user_explode_view'))
  );
  for (const name of ['Leaf A', 'Leaf B'])
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 2, depth: 40 }
      })
    );
  const [a, b] = manager.document.bodyOrder as [BodyId, BodyId];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        { componentId: 'comp_a', name: 'Leaf A', bodyId: a, grounded: true },
        { componentId: 'comp_b', name: 'Leaf B', bodyId: b, grounded: false }
      ]
    })
  );
  manager.execute(
    commandFactories.addAssemblyJoint({
      joint: {
        id: 'joint_hinge',
        name: 'Hinge',
        kind: 'revolute',
        parent: { componentId: 'comp_a', frame: PIVOT },
        child: { componentId: 'comp_b', frame: PIVOT },
        values: [90],
        limits: [null]
      }
    })
  );
  manager.execute(
    commandFactories.setAssemblyExplode({
      offsets: { comp_b: { x: 0, y: 0, z: 30 } }
    })
  );
  return { manager, a, b };
}

const base = {
  overrides: new Map<string, number[]>(),
  placementOverrides: new Map(),
  selectedJointId: null,
  jointTool: null
};

afterEach(() => {
  assemblyRuntime.reset();
  assemblyRuntime.setActive(false);
  registerAssemblyCommitHandlers(null);
});

describe('exploded view model', () => {
  it('shows stored offsets only while exploded, after the pose, and hides joint glyphs', () => {
    const { manager, b } = hinge();
    const assembled = buildAssemblyView(manager.document, base)!;
    const pose = solveAssembly(manager.document.assembly!).poses.get('comp_b')!;
    expect(assembled.exploded).toBe(false);
    expect(assembled.matrices.get(b)).toEqual(transformToMatrix4(pose));
    expect(assembled.glyphs).toHaveLength(1);

    const exploded = buildAssemblyView(manager.document, {
      ...base,
      exploded: true
    })!;
    expect(exploded.exploded).toBe(true);
    expect(exploded.glyphs).toHaveLength(0);
    expect(exploded.explodeOffsets.get('comp_b')).toEqual({
      x: 0,
      y: 0,
      z: 30
    });
    // A world translation on top of the turned pose: the rotation is kept.
    expect(exploded.matrices.get(b)).toEqual(
      transformToMatrix4({
        t: { x: pose.t.x, y: pose.t.y, z: pose.t.z + 30 },
        q: pose.q
      })
    );
    // The solve is the assembled one: offsets never move a joint.
    expect(exploded.solution.values).toEqual(assembled.solution.values);
  });

  it('shows a drag in progress instead of the stored offset', () => {
    const { manager, a, b } = hinge();
    const view = buildAssemblyView(manager.document, {
      ...base,
      exploded: true,
      explodeOverrides: new Map([['comp_a', { x: -5, y: 0, z: 0 }]])
    })!;
    expect(view.explodeOffsets.get('comp_a')).toEqual({ x: -5, y: 0, z: 0 });
    expect(view.matrices.get(a)?.slice(12, 15)).toEqual([-5, 0, 0]);
    expect(view.explodeOffsets.get('comp_b')).toEqual({ x: 0, y: 0, z: 30 });
    expect(view.matrices.get(b)).toBeDefined();
  });
});

describe('exploded drag math', () => {
  it('follows the axis whose screen direction carries the pointer travel', () => {
    const projected = {
      x: { x: 10, y: 0 },
      y: { x: 0, y: -10 },
      z: { x: 1, y: 1 }
    };
    expect(chooseExplodeAxis(projected, { dx: 6, dy: 1 })).toBe('x');
    expect(chooseExplodeAxis(projected, { dx: 0, dy: 4 })).toBe('y');
    expect(chooseExplodeAxis(projected, { dx: 0, dy: 0 })).toBeNull();
    // A foreshortened axis loses even when it points the same way.
    expect(
      chooseExplodeAxis(
        { x: { x: 0.5, y: 0 }, y: { x: 0, y: 0 }, z: { x: 8, y: 1 } },
        { dx: 3, dy: 0 }
      )
    ).toBe('z');
  });

  it('reads a snapped offset along that axis from a real camera', () => {
    const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
    camera.position.set(0, -200, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    // 100 world units across a 400 px viewport: 0.25 units per pixel.
    const session = beginExplodeDrag(
      { x: 0, y: 0, z: 0 },
      camera,
      { width: 400, height: 400 },
      () => 0.25,
      { dx: 0, dy: -8 },
      { x: 2, y: 0, z: 10 }
    )!;
    // Looking along +Y with Z up: an upward drag is +Z.
    expect(session.axis).toBe('z');
    const up = readExplodeDrag(session, 0, -101, 0.1, false);
    expect(up.offset).toEqual({ x: 2, y: 0, z: 35.3 });
    expect(up.distance).toBeCloseTo(25.3, 9);
    expect(formatExplodeDragValue('z', up.distance)).toBe('Z +25.3 mm');
    const down = readExplodeDrag(session, 0, 40, 0.1, false);
    expect(down.offset.z).toBe(0);
    expect(formatExplodeDragValue('z', down.distance, 'inch')).toBe(
      'Z -10.00 in'
    );
    // Shift keeps a free value (two decimals, like Move).
    expect(readExplodeDrag(session, 0, -1, 0.1, true).offset.z).toBe(10.25);
  });

  it('starts no drag without a usable camera scale', () => {
    const camera = new THREE.PerspectiveCamera();
    expect(
      beginExplodeDrag(
        { x: 0, y: 0, z: 0 },
        camera,
        { width: 400, height: 400 },
        () => 0,
        { dx: 5, dy: 0 },
        { x: 0, y: 0, z: 0 }
      )
    ).toBeNull();
  });
});

describe('exploded view runtime', () => {
  it('commits one drag as one handler call and clears the transient offset', () => {
    const commitExplode = vi.fn();
    registerAssemblyCommitHandlers({
      commitPose: vi.fn(),
      createJoint: vi.fn(),
      commitExplode
    });
    assemblyRuntime.setExploded(true);
    assemblyRuntime.setExplodeOverride('comp_b', { x: 0, y: 0, z: 10 });
    assemblyRuntime.setExplodeOverride('comp_b', { x: 0, y: 0, z: 20 });
    assemblyRuntime.commitExplodeOverrides();
    expect(commitExplode).toHaveBeenCalledTimes(1);
    expect(commitExplode).toHaveBeenCalledWith({
      comp_b: { x: 0, y: 0, z: 20 }
    });
    expect(getAssemblyRuntime().explodeOverrides.size).toBe(0);
    // Nothing dragged, nothing committed.
    assemblyRuntime.commitExplodeOverrides();
    expect(commitExplode).toHaveBeenCalledTimes(1);
  });

  it('closes the joint tools when exploding, and tools collapse the view', () => {
    assemblyRuntime.openJointTool();
    assemblyRuntime.setExploded(true);
    expect(getAssemblyRuntime().jointTool).toBeNull();
    expect(getAssemblyRuntime().exploded).toBe(true);
    assemblyRuntime.setExplodeOverride('comp_b', { x: 1, y: 0, z: 0 });
    assemblyRuntime.openJointTool();
    expect(getAssemblyRuntime().exploded).toBe(false);
    expect(getAssemblyRuntime().explodeOverrides.size).toBe(0);
  });

  it('collapses when leaving the workspace', () => {
    assemblyRuntime.setActive(true);
    assemblyRuntime.setExploded(true);
    assemblyRuntime.setActive(false);
    expect(getAssemblyRuntime().exploded).toBe(false);
  });
});
