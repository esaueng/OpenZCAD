import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type AssemblyFrame,
  type AssemblyMotionStudy,
  type BodyId
} from '@openzcad/shared';

const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

/** Test-only: two blades on a revolute pivot, with one two-key study. */
export function pivotProject(options: { study?: boolean } = {}) {
  const manager = new CommandManager(
    createProjectDocument('Scissors', toUserId('user_motion'))
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
        id: 'j_pivot',
        name: 'Pivot',
        kind: 'revolute',
        parent: { componentId: 'comp_a', frame: PIVOT },
        child: { componentId: 'comp_b', frame: PIVOT },
        values: [0],
        limits: [null]
      }
    })
  );
  if (options.study !== false) {
    const study: AssemblyMotionStudy = {
      id: 'study_1',
      name: 'Motion 1',
      durationS: 2,
      playback: 'loop',
      tracks: [
        {
          jointId: 'j_pivot',
          dof: 0,
          keys: [
            { t: 0, value: 0, easing: 'linear' },
            { t: 2, value: 90, easing: 'linear' }
          ]
        }
      ]
    };
    manager.execute(commandFactories.setAssemblyStudy({ study }));
  }
  return manager;
}

/**
 * Test-only: a fixed plate with two parts turning on it, coupled at −0.5
 * (B = −A / 2). B is limited to ±20°, so the pair can only travel A ±40°.
 * `saved` are the joints' stored angles (they must satisfy the coupling).
 */
export function coupledPairProject(
  options: { limited?: boolean; saved?: [number, number] } = {}
) {
  const manager = new CommandManager(
    createProjectDocument('Gears', toUserId('user_motion'))
  );
  for (const name of ['Plate', 'Gear A', 'Gear B'])
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 2, depth: 10 }
      })
    );
  const bodies = manager.document.bodyOrder;
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: ['plate', 'a', 'b'].map((id, index) => ({
        componentId: id,
        name: id,
        bodyId: bodies[index] as BodyId,
        grounded: id === 'plate'
      }))
    })
  );
  const [savedA, savedB] = options.saved ?? [0, 0];
  for (const [id, child, x, value] of [
    ['turn_a', 'a', 0, savedA],
    ['turn_b', 'b', 50, savedB]
  ] as const) {
    const frame = { ...PIVOT, origin: { x, y: 0, z: 0 } };
    manager.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          id,
          name: id === 'turn_a' ? 'Turn A' : 'Turn B',
          kind: 'revolute',
          parent: { componentId: 'plate', frame },
          child: { componentId: child, frame },
          values: [value],
          limits: [
            id === 'turn_b' && options.limited !== false
              ? { min: -20, max: 20 }
              : null
          ]
        }
      })
    );
  }
  manager.execute(
    commandFactories.addAssemblyCoupling({
      coupling: {
        id: 'mesh',
        name: 'Gear ratio',
        driver: { jointId: 'turn_a', dof: 0 },
        driven: { jointId: 'turn_b', dof: 0 },
        ratio: -0.5,
        offset: 0
      }
    })
  );
  return manager;
}
