import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  deriveAssemblyBom,
  mergeCollaborationDocuments,
  normalizeDocument
} from '@openzcad/document-core';
import {
  solveAssembly,
  toProjectId,
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  chooseProjectDocument,
  loadLocalProject,
  projectsHaveSameCanonicalContent,
  saveLocalProject
} from '../localProjectStore';

/**
 * AS01/AS02 save, reopen and conflict contract (AS03 builds on it): the
 * assembly section is saved document content, so it survives the device
 * store exactly, takes part in every open-time comparison, and the room's
 * three-way merge keeps independent edits while refusing to pick between two
 * edits of the same joints or components. Nothing here is silently dropped.
 */

const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function scissors(): { manager: CommandManager; bodies: BodyId[] } {
  const document = createProjectDocument('Scissors', toUserId('user_as'));
  const manager = new CommandManager({
    ...document,
    projectId: toProjectId('project_assembly_persistence')
  });
  for (const name of ['Blade A', 'Blade B', 'Pivot screw']) {
    manager.execute(
      commandFactories.addPrimitive({
        name,
        bodyName: name,
        primitiveKind: 'box',
        dimensions: { width: 60, height: 4, depth: 12 }
      })
    );
  }
  const bodies = [...manager.document.bodyOrder];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'comp_a',
          name: 'Blade A',
          bodyId: bodies[0]!,
          grounded: true
        },
        {
          componentId: 'comp_b',
          name: 'Blade B',
          bodyId: bodies[1]!,
          grounded: false
        }
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
        limits: [{ min: 0, max: 35 }]
      }
    })
  );
  manager.execute(
    commandFactories.saveAssemblyPosition({
      positionId: 'pos_open',
      name: 'Open',
      values: { joint_pivot: [30] }
    })
  );
  manager.execute(
    commandFactories.setAssemblyStudy({
      study: {
        id: 'study_1',
        name: 'Animation 1',
        durationS: 2,
        playback: 'ping-pong',
        tracks: [
          {
            jointId: 'joint_pivot',
            dof: 0,
            keys: [
              { t: 0, value: 0, easing: 'linear' },
              { t: 2, value: 35, easing: 'ease' }
            ]
          }
        ]
      }
    })
  );
  return { manager, bodies };
}

/** The same project continued on a second device from `base`. */
function fork(base: ProjectDocument): CommandManager {
  return new CommandManager(structuredClone(base));
}

const pose = (manager: CommandManager, angle: number) =>
  manager.execute(
    commandFactories.setAssemblyPose({ values: { joint_pivot: [angle] } })
  );

const pivotAngle = (document: ProjectDocument) =>
  document.assembly?.joints.find((joint) => joint.id === 'joint_pivot')
    ?.values[0];

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('assembly save and reopen on the device (AS01/AS02)', () => {
  it('reopens components, grounding, joints, limits, poses, positions and studies exactly', async () => {
    const { manager } = scissors();
    pose(manager, 25);
    const saved = manager.document;
    await saveLocalProject(saved);
    const reopened = await loadLocalProject(saved.projectId);
    expect(reopened).not.toBeNull();
    const normalized = normalizeDocument(reopened!);
    expect(normalized.assembly).toEqual(saved.assembly);
    expect(pivotAngle(normalized)).toBe(25);
    // The pose the saved transforms give is the one that was shown.
    expect(solveAssembly(normalized.assembly!)).toEqual(
      solveAssembly(saved.assembly!)
    );
    expect(
      deriveAssemblyBom(normalized, () => true).rows.map((row) => row.name)
    ).toEqual(['Blade A', 'Blade B']);
    // The reopened copy is the same content the account would compare.
    expect(projectsHaveSameCanonicalContent(saved, normalized)).toBe(true);
  });

  it('keeps a pose edited offline and undoes it as one step after reopening', async () => {
    const { manager } = scissors();
    pose(manager, 10);
    await saveLocalProject(manager.document);
    // Offline edit on the device: a drag lands as one pose command.
    pose(manager, 35);
    await saveLocalProject(manager.document);
    const reopened = new CommandManager(
      normalizeDocument(
        (await loadLocalProject(manager.document.projectId)) as ProjectDocument
      )
    );
    expect(pivotAngle(reopened.document)).toBe(35);
    expect(reopened.canUndo).toBe(true);
    reopened.undo();
    expect(pivotAngle(reopened.document)).toBe(10);
  });
});

describe('opening a project whose copies differ only in the assembly', () => {
  it('treats a pose-only change as content, not bookkeeping', () => {
    const { manager } = scissors();
    const synced = manager.document;
    const moved = fork(synced);
    pose(moved, 20);
    expect(projectsHaveSameCanonicalContent(synced, moved.document)).toBe(
      false
    );
    // Only this device moved since the last sync: it keeps its pose.
    expect(
      chooseProjectDocument(moved.document, synced, synced.version)
    ).toMatchObject({ choice: 'local' });
    // Only the account moved: the device takes the account's pose.
    expect(
      chooseProjectDocument(synced, moved.document, synced.version)
    ).toMatchObject({ choice: 'remote' });
  });

  it('asks rather than choosing when both copies posed the assembly differently', () => {
    const { manager } = scissors();
    const synced = manager.document;
    const deviceA = fork(synced);
    const deviceB = fork(synced);
    pose(deviceA, 12);
    pose(deviceB, 30);
    const choice = chooseProjectDocument(
      deviceB.document,
      deviceA.document,
      synced.version
    );
    expect(choice.choice).toBe('diverged');
  });
});

describe('room merges of concurrent assembly edits', () => {
  it('keeps a pose made on one device and a body rename made on the other', () => {
    const { manager } = scissors();
    const base = manager.document;
    const latest = fork(base);
    const incoming = fork(base);
    const bladeNode = Object.values(base.nodes).find(
      (node) => node.kind === 'body' && node.name === 'Blade B'
    )!;
    latest.execute(
      commandFactories.renameNode({ nodeId: bladeNode.id, name: 'Lower blade' })
    );
    pose(incoming, 20);
    const merged = mergeCollaborationDocuments(
      base,
      latest.document,
      incoming.document
    );
    expect(merged).not.toBeNull();
    expect(pivotAngle(merged!)).toBe(20);
    expect(merged!.nodes[bladeNode.id]).toMatchObject({ name: 'Lower blade' });
    expect(
      deriveAssemblyBom(merged!, () => true).rows.map((row) => row.name)
    ).toEqual(['Blade A', 'Lower blade']);
  });

  it('refuses to merge two different poses of the same joint', () => {
    const { manager } = scissors();
    const base = manager.document;
    const latest = fork(base);
    const incoming = fork(base);
    pose(latest, 12);
    pose(incoming, 30);
    expect(
      mergeCollaborationDocuments(base, latest.document, incoming.document)
    ).toBeNull();
  });

  it('refuses a joint added on one device to a part removed on the other', () => {
    const { manager, bodies } = scissors();
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: [
          {
            componentId: 'comp_screw',
            name: 'Pivot screw',
            bodyId: bodies[2]!,
            grounded: false
          }
        ]
      })
    );
    const base = manager.document;
    const latest = fork(base);
    const incoming = fork(base);
    latest.execute(
      commandFactories.deleteAssemblyComponent({ componentId: 'comp_screw' })
    );
    incoming.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          id: 'joint_screw',
          name: 'Screw',
          kind: 'rigid',
          parent: { componentId: 'comp_a', frame: PIVOT },
          child: { componentId: 'comp_screw', frame: PIVOT },
          values: [],
          limits: []
        }
      })
    );
    expect(
      mergeCollaborationDocuments(base, latest.document, incoming.document)
    ).toBeNull();
  });

  it('refuses the same body added as a part on both devices under different ids', () => {
    const { manager, bodies } = scissors();
    const base = manager.document;
    const latest = fork(base);
    const incoming = fork(base);
    for (const [device, id] of [
      [latest, 'comp_screw_a'],
      [incoming, 'comp_screw_b']
    ] as const) {
      device.execute(
        commandFactories.addAssemblyComponents({
          components: [
            {
              componentId: id,
              name: 'Pivot screw',
              bodyId: bodies[2]!,
              grounded: false
            }
          ]
        })
      );
    }
    expect(
      mergeCollaborationDocuments(base, latest.document, incoming.document)
    ).toBeNull();
  });
});
