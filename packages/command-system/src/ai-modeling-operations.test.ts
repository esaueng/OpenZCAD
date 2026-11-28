import { describe, expect, it } from 'vitest';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  addSketchFeature,
  createProjectDocument,
  findFeature,
  findSketch,
  helicalSweepProfile,
  holeBody,
  type ExtrudeInput
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
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

    // Old assistant history can display an explicit rim choice but cannot authorize it.
    const direct = proposal.operations[0]!;
    if (
      direct.kind !== 'add_direct_edit' ||
      direct.operation.kind !== 'offset-face'
    ) {
      throw new Error('Expected the offset proposal fixture.');
    }
    const offset = direct.operation;
    for (const ambiguousRim of ['draft', 'chamfer'] as const) {
      expect(() =>
        commandsForCadPatch(baseline, {
          ...proposal,
          operations: [{ ...direct, operation: { ...offset, ambiguousRim } }]
        })
      ).toThrow('Choose Chamfer or Draft');
    }
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

  it('rejects retargeting a body a historical hole or split consumed', () => {
    const manager = new CommandManager(
      createProjectDocument('Consumed history', toUserId('user_ai'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      })
    );
    const plateBodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Tool',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      })
    );
    const toolBodyId = manager.document.bodyOrder[1]!;
    const holed = holeBody(manager.document, {
      name: 'Mounting hole',
      targetBodyId: plateBodyId,
      faceHash: 4242,
      style: 'simple',
      diameter: 6,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    // Fresh load: derived is absent/stale, so only the history-primary
    // LocalBodyScope stands between the proposal and the wrong model.
    const historyOnly = { ...holed.document, derived: undefined as never };
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_consumed_retarget',
      summary: 'Retarget a consumed body.',
      assumptions: [],
      operations: [
        {
          kind: 'add_boolean',
          name: 'Bad union',
          localId: null,
          operation: 'union',
          targetBodyIds: [plateBodyId, toolBodyId]
        }
      ]
    });

    expect(() => commandsForCadPatch(historyOnly, proposal)).toThrow(
      /already consumed/
    );
    expect(manager.document.featureOrder).toHaveLength(2);
  });

  it('refuses a new radius for a coil wound in place, and applies one to a faceted helix (#2120)', () => {
    const radiusEdit = (construction?: 'in-place') => {
      const wire = addSketchFeature(
        createProjectDocument('Spring', toUserId('user_ai')),
        {
          name: 'Wire',
          planeRef: { type: 'canonical', plane: 'XZ', offset: 0 },
          objects: [
            { objectKind: 'circle', centerX: 12, centerY: 0, radius: 1.5 }
          ]
        }
      );
      const { document } = helicalSweepProfile(wire.document, {
        name: 'Spring',
        profile: {
          sketchId: wire.sketchId,
          profile: {
            all: true,
            sourceEntityIds: [
              ...findSketch(wire.document, wire.sketchId)!.objectIds
            ]
          }
        },
        axisOrigin: { x: 0, y: 0, z: 0 },
        axisDirection: { x: 0, y: 0, z: 1 },
        radius: 12,
        pitch: 5.25,
        turns: 6.25,
        ...(construction ? { construction } : {})
      });
      const featureId = document.featureOrder.at(-1)!;
      const proposal = (data: Record<string, unknown>) =>
        parseCadPatchProposal({
          proposalId: 'proposal_coil_radius',
          summary: 'Widen the spring.',
          assumptions: [],
          operations: [
            { kind: 'update_feature', featureId, data, clearData: [] }
          ]
        });
      return { document, featureId, proposal };
    };

    // Wound in place the coil runs through its profile: the stored radius
    // builds nothing, so the edit would be accepted and change nothing.
    const exact = radiusEdit('in-place');
    expect(() =>
      commandsForCadPatch(exact.document, exact.proposal({ radius: 20 }))
    ).toThrow(/wound through its profile.*Move the profile in its sketch/);
    // The record written back as it stands, beside a real change, is no edit.
    const pitched = applyCandidate(
      exact.document,
      commandsForCadPatch(
        exact.document,
        exact.proposal({ radius: 12, pitch: 6 })
      )
    );
    expect(findFeature(pitched, exact.featureId)).toMatchObject({
      data: { radius: 12, pitch: 6, construction: 'in-place' }
    });

    const faceted = radiusEdit();
    const widened = applyCandidate(
      faceted.document,
      commandsForCadPatch(faceted.document, faceted.proposal({ radius: 20 }))
    );
    expect(findFeature(widened, faceted.featureId)).toMatchObject({
      data: { radius: 20 }
    });
  });
});

it.each(['rectangle', 'polygon'] as const)(
  'AI profile writers retain the %s boundary identity before and after explicit conversion',
  (kind) => {
    const manager = new CommandManager(
      createProjectDocument('AI provenance', toUserId('user_ai'))
    );
    const data =
      kind === 'rectangle'
        ? {
            objectKind: 'rectangle' as const,
            width: 20,
            height: 12,
            centerX: 0,
            centerY: 0
          }
        : {
            objectKind: 'polygon' as const,
            sides: 6,
            radius: 10,
            centerX: 0,
            centerY: 0
          };
    const add = commandFactories.addSketch({
      name: 'Legacy AI source',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        data,
        { objectKind: 'circle', radius: 3, centerX: 50, centerY: 0 }
      ]
    });
    manager.execute(add);
    const sketchId = add.payload.ids!.sketchId;
    const sourceObjectId = findSketch(manager.document, sketchId)!
      .objectIds[0]!;
    const expected = computeSketchRegions(
      [{ id: sourceObjectId, data }],
      Number
    )[0]!.sourceBoundaryLoops;
    expect(expected?.outer).toHaveLength(kind === 'rectangle' ? 4 : 6);
    for (const converted of [false, true]) {
      if (converted)
        manager.execute(
          commandFactories.convertLegacySketchObject({
            sketchId,
            sourceObjectId
          })
        );
      for (const multi of [false, true]) {
        const proposal = parseCadPatchProposal({
          proposalId: `boundary_${converted}_${multi}`,
          summary: 'Persist authored boundary provenance.',
          assumptions: [],
          operations: [
            multi
              ? {
                  kind: 'add_multi_profile_extrude',
                  name: 'From converted graph',
                  sketchId,
                  distance: 5,
                  samplePoints: [
                    { x: 0, y: 0 },
                    { x: 50, y: 0 }
                  ]
                }
              : {
                  kind: 'add_extrude',
                  name: 'From converted graph',
                  sketchId,
                  distance: 5,
                  samplePoint: { x: 0, y: 0 }
                }
          ]
        });
        const command = commandsForCadPatch(manager.document, proposal).find(
          (c) => c.kind === 'feature.extrude'
        )!;
        const payload = command.serialize().payload as ExtrudeInput;
        const profile = payload.profile ?? payload.profiles![0]!;
        if (profile.all === true)
          throw new Error('Composite profile became entity-wide');
        expect(profile.sourceBoundaryLoops).toEqual(expected);
      }
    }
  }
);
