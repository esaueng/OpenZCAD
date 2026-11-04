import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';

/** A joint frame at the origin, Z up: both blades' pivot hole. */
export const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

/**
 * A document with live (not consumed) body representations, which a fresh
 * command manager never builds: the Assemble panels read names and
 * liveness from them.
 */
export function withLiveBodies(
  document: ProjectDocument,
  names: Record<string, string>
): ProjectDocument {
  const bodyRepresentations: Record<string, BodyRepresentation> = {};
  for (const [bodyId, name] of Object.entries(names))
    bodyRepresentations[bodyId] = {
      bodyId: bodyId as BodyId,
      name,
      consumed: false
    } as BodyRepresentation;
  return {
    ...document,
    derived: { ...document.derived, bodyRepresentations }
  };
}

/**
 * Two blade bodies, optionally already components with a revolute pin, and
 * optionally a third body (a pivot screw) that is not in the assembly.
 */
export function scissorsManager(
  options: { components?: boolean; joint?: boolean; screw?: boolean } = {}
) {
  const manager = new CommandManager(
    createProjectDocument('Scissors', toUserId('user_assemble'))
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
  if (options.screw)
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Pivot screw',
        primitiveKind: 'cylinder',
        dimensions: { radius: 3, height: 10 }
      })
    );
  const screw = manager.document.bodyOrder[2];
  if (options.components || options.joint)
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: [
          { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
          { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
        ]
      })
    );
  if (options.joint)
    manager.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          id: 'joint_pin',
          name: 'Pivot',
          kind: 'revolute',
          parent: { componentId: 'comp_a', frame: PIVOT },
          child: { componentId: 'comp_b', frame: PIVOT },
          values: [12],
          limits: [null]
        }
      })
    );
  const live = () =>
    withLiveBodies(manager.document, {
      [a]: 'Blade A',
      [b]: 'Blade B',
      ...(screw ? { [screw]: 'Pivot screw' } : {})
    });
  return { manager, a, b, screw, live };
}

/**
 * An `execute` that runs commands on the manager, as the app's command path
 * does, and records each one.
 */
export function recordingExecute(manager: CommandManager) {
  const commands: { kind: string; payload: unknown }[] = [];
  const execute = (command: Parameters<CommandManager['execute']>[0]) => {
    commands.push({ kind: command.kind, payload: command.payload });
    manager.execute(command);
    return true;
  };
  return { commands, execute };
}
