import { describe, expect, it } from 'vitest';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toFeatureId,
  toUserId,
  type FaceTopologyReferenceV5,
  type ProjectDocument
} from '@openzcad/shared';

import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  replayCommands,
  type AnyCommand
} from './index';

const faceReference: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: toFeatureId('feature_source'),
  lineageName: 'feature_source/face:top',
  currentHash: 101,
  witnessVersion: 1,
  witness: {
    surfaceType: 'plane',
    perimeter: 40_000_000,
    centroid: [0, 0, 10_000_000],
    analytic: {
      kind: 'plane',
      normal: [0, 0, 1_000_000_000],
      offset: 10_000_000
    },
    closure: { u: 'open', v: 'open' }
  }
};

function applyCandidate(
  document: ProjectDocument,
  commands: AnyCommand[]
): ProjectDocument {
  return commands.reduce((candidate, command) => {
    command.validate(candidate);
    return command.apply(candidate);
  }, document);
}

describe('AI modeling command translation', () => {
  it('constructs deterministic commands, preserves references, and replays undoably', () => {
    const root = createProjectDocument('AI modeling', toUserId('user_ai'));
    const manager = new CommandManager(root);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Source',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      })
    );
    const baseline = manager.document;
    const sourceBodyId = baseline.bodyOrder[0]!;

    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_all_modeling',
      summary: 'Exercise every deterministic AI modeling command.',
      assumptions: [],
      operations: [
        {
          kind: 'add_direct_edit',
          name: 'Raise top',
          targetBodyId: sourceBodyId,
          operation: {
            kind: 'offset-face',
            faceHash: 101,
            faceReference,
            sourceSurfaceType: 'plane',
            sourceArea: 400,
            sourceCenter: { x: 0, y: 0, z: 10 },
            sourceNormal: { x: 0, y: 0, z: 1 },
            offset: 2
          }
        },
        {
          kind: 'add_face_sketch',
          name: 'Twin profiles',
          localId: 'profiles',
          planeRef: {
            type: 'face',
            bodyId: sourceBodyId,
            faceHash: 101,
            faceReference,
            sourceArea: 400,
            sourceCenter: { x: 0, y: 0, z: 10 },
            sourceNormal: { x: 0, y: 0, z: 1 },
            frame: {
              origin: { x: 0, y: 0, z: 10 },
              xAxis: { x: 1, y: 0, z: 0 },
              yAxis: { x: 0, y: 1, z: 0 },
              zAxis: { x: 0, y: 0, z: 1 }
            }
          },
          objects: [
            {
              objectKind: 'circle',
              radius: 2,
              centerX: -5,
              centerY: 0
            },
            {
              objectKind: 'circle',
              radius: 2,
              centerX: 5,
              centerY: 0
            }
          ]
        },
        {
          kind: 'add_multi_profile_extrude',
          name: 'Twin bosses',
          localId: 'bosses',
          sketchId: '$profiles',
          distance: 4,
          samplePoints: [
            { x: -5, y: 0 },
            { x: 5, y: 0 }
          ]
        },
        {
          kind: 'add_mirror',
          name: 'Mirrored bosses',
          localId: 'mirrored',
          targetBodyId: '$bosses',
          plane: {
            origin: { x: 0, y: 0, z: 0 },
            normal: { x: 1, y: 0, z: 0 }
          }
        },
        {
          kind: 'add_shell',
          name: 'Open source',
          localId: 'shell',
          targetBodyId: sourceBodyId,
          openingFaceHashes: [101],
          openingFaceReferences: [faceReference],
          thickness: 1
        },
        {
          kind: 'add_solid_offset',
          name: 'Offset mirrored bosses',
          localId: 'offset',
          targetBodyId: '$mirrored',
          distance: 0.5
        }
      ]
    });

    const commands = commandsForCadPatch(baseline, proposal);
    expect(commands.map((command) => command.kind)).toEqual([
      'feature.direct-edit',
      'sketch.add',
      'feature.extrude',
      'feature.mirror',
      'feature.shell',
      'feature.solid-offset'
    ]);
    expect(commands[0]?.payload).toMatchObject({
      operation: { faceReference }
    });
    expect(commands[1]?.payload).toMatchObject({
      planeRef: { faceReference }
    });
    expect(commands[2]?.payload).toMatchObject({
      profiles: [
        { samplePoint: { x: -5, y: 0 } },
        { samplePoint: { x: 5, y: 0 } }
      ]
    });
    expect(commands[4]?.payload).toMatchObject({
      openingFaceReferences: [faceReference]
    });

    const firstCandidate = applyCandidate(baseline, commands);
    const secondCandidate = applyCandidate(baseline, commands);
    expect(secondCandidate.nodes).toEqual(firstCandidate.nodes);
    expect(secondCandidate.featureOrder).toEqual(firstCandidate.featureOrder);
    expect(secondCandidate.bodyOrder).toEqual(firstCandidate.bodyOrder);

    commands.forEach((command) => manager.execute(command));
    const replayed = replayCommands(root, manager.document.commandLog);
    expect(replayed.nodes).toEqual(manager.document.nodes);
    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);

    const completedBodies = manager.document.bodyOrder.length;
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(completedBodies - 1);
    manager.redo();
    expect(manager.document.bodyOrder).toHaveLength(completedBodies);
  });

  it('rejects duplicate multi-profile picks before constructing a command', () => {
    const manager = new CommandManager(
      createProjectDocument('Duplicate profiles', toUserId('user_ai'))
    );
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_duplicate_profiles',
      summary: 'Do not extrude the same cell twice.',
      assumptions: [],
      operations: [
        {
          kind: 'add_sketch',
          name: 'Profile',
          localId: 'profile',
          plane: 'XY',
          offset: 0,
          objects: [
            {
              objectKind: 'circle',
              radius: 4,
              centerX: 0,
              centerY: 0
            }
          ]
        },
        {
          kind: 'add_multi_profile_extrude',
          name: 'Duplicate',
          localId: null,
          sketchId: '$profile',
          distance: 5,
          samplePoints: [
            { x: 0, y: 0 },
            { x: 1, y: 0 }
          ]
        }
      ]
    });

    expect(() => commandsForCadPatch(manager.document, proposal)).toThrow(
      /same closed region more than once/
    );
    expect(manager.document.featureOrder).toEqual([]);
  });
});
