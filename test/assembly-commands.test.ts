import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  assemblyComponentBodies,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  UnstorableDocumentError
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  placementToTransform,
  solveAssembly,
  toEntityId,
  toUserId,
  transformPoint,
  type AssemblyFrame,
  type AssemblyJoint,
  type BodyId,
  type FeatureNode,
  type BodyNode,
  type ProjectDocument
} from '@openzcad/shared';
import { geometryContentKey } from '../apps/web/src/worker/exactRebuildCache';
import { createProjectDiagnosticBundle } from '../apps/web/src/lib/projectDiagnostics';
import * as webGlimpse from '../apps/web/src/lib/glimpseContract';
import * as workerGlimpse from '../apps/web/worker/glimpseContract';

/**
 * AS01/AS02 assembly commands (schema v54): components from bodies,
 * grounding, joints and poses, each one undoable `assembly.*` step that no
 * rebuild reads.
 */
const owner = toUserId('user_assembly');
const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function twoBlades() {
  const manager = new CommandManager(createProjectDocument('Scissors', owner));
  for (const name of ['Blade A', 'Blade B']) {
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 2, depth: 100 }
      })
    );
  }
  const [a, b] = manager.document.bodyOrder as [BodyId, BodyId];
  return { manager, a, b };
}

function pivot(values = [0]): AssemblyJoint {
  return {
    id: 'joint_pivot',
    name: 'Pivot',
    kind: 'revolute',
    parent: {
      componentId: 'comp_a',
      frame: PIVOT,
      source: { kind: 'circle', label: 'Hole edge · centre' }
    },
    child: { componentId: 'comp_b', frame: PIVOT },
    values,
    limits: [{ min: 0, max: 35 }]
  };
}

function assembled() {
  const fixture = twoBlades();
  fixture.manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'comp_a',
          name: 'Blade A',
          bodyId: fixture.a,
          grounded: true
        },
        {
          componentId: 'comp_b',
          name: 'Blade B',
          bodyId: fixture.b,
          grounded: false
        }
      ]
    })
  );
  fixture.manager.execute(
    commandFactories.addAssemblyJoint({ joint: pivot() })
  );
  return fixture;
}

describe('assembly commands (AS01/AS02, schema v54)', () => {
  it('is additive: absent from a project without an assembly', () => {
    const { manager } = twoBlades();
    expect(manager.document.schemaVersion).toBe(
      PROJECT_DOCUMENT_SCHEMA_VERSION
    );
    expect(manager.document.assembly).toBeUndefined();
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    const opened = normalizeDocument({
      ...saved,
      schemaVersion: 40
    } as unknown as ProjectDocument);
    expect('assembly' in opened).toBe(false);
  });

  it('adds components and a joint as single undoable steps that leave geometry alone', () => {
    const { manager, a, b } = twoBlades();
    const geometryBefore = geometryContentKey(manager.document);
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: [
          {
            componentId: 'comp_a',
            name: ' Blade A ',
            bodyId: a,
            grounded: true
          },
          { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
        ]
      })
    );
    expect(manager.document.assembly?.components.map((c) => c.name)).toEqual([
      'Blade A',
      'Blade B'
    ]);
    expect(manager.undoIsAssemblyOnly).toBe(true);
    manager.execute(commandFactories.addAssemblyJoint({ joint: pivot([12]) }));
    expect(manager.document.assembly?.joints[0]?.values).toEqual([12]);
    expect(geometryContentKey(manager.document)).toBe(geometryBefore);
    manager.undo();
    expect(manager.document.assembly?.joints).toEqual([]);
    manager.undo();
    expect(manager.document.assembly).toBeUndefined();
    manager.redo();
    manager.redo();
    expect(manager.document.assembly?.joints).toHaveLength(1);
  });

  it('replays to the same assembly and survives a save round trip', () => {
    const { manager } = assembled();
    manager.execute(
      commandFactories.setAssemblyPose({ values: { joint_pivot: [20] } })
    );
    const replayed = replayCommands(
      createProjectDocument('Scissors', owner),
      manager.document.commandLog
    );
    expect(replayed.assembly).toEqual(manager.document.assembly);
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(() => assertStorableDocument(saved)).not.toThrow();
    expect(normalizeDocument(saved).assembly).toEqual(
      manager.document.assembly
    );
  });

  it('clamps a pose into the joint limits', () => {
    const { manager } = assembled();
    manager.execute(
      commandFactories.setAssemblyPose({ values: { joint_pivot: [90] } })
    );
    expect(manager.document.assembly?.joints[0]?.values).toEqual([35]);
  });

  it('keeps a driven component where it is when it is grounded or unjoined', () => {
    const { manager } = assembled();
    manager.execute(
      commandFactories.setAssemblyPose({ values: { joint_pivot: [30] } })
    );
    const before = solveAssembly(manager.document.assembly!).poses.get(
      'comp_b'
    )!;
    const tip = { x: 100, y: 0, z: 1 };
    manager.execute(
      commandFactories.deleteAssemblyJoint({ jointId: 'joint_pivot' })
    );
    const freed = manager.document.assembly!.components.find(
      (c) => c.id === 'comp_b'
    )!;
    const after = placementToTransform(freed.placement);
    const expected = transformPoint(before, tip);
    const actual = transformPoint(after, tip);
    expect(
      Math.hypot(
        actual.x - expected.x,
        actual.y - expected.y,
        actual.z - expected.z
      )
    ).toBeLessThan(1e-9);
  });

  it('refuses a second joint on the same pair and a joint to a missing component', () => {
    const { manager } = assembled();
    expect(() =>
      manager.execute(
        commandFactories.addAssemblyJoint({
          joint: { ...pivot(), id: 'joint_two', name: 'Two' }
        })
      )
    ).toThrow(/already joined/);
    expect(() =>
      manager.execute(
        commandFactories.addAssemblyJoint({
          joint: {
            ...pivot(),
            id: 'joint_three',
            child: { componentId: 'ghost', frame: PIVOT }
          }
        })
      )
    ).toThrow(/components of this assembly/);
  });

  it('removes a component with its joints, tracks and saved values', () => {
    const { manager } = assembled();
    manager.execute(
      commandFactories.saveAssemblyPosition({
        positionId: 'pos_open',
        name: 'Open',
        values: { joint_pivot: [35] }
      })
    );
    manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          id: 'study_1',
          name: 'Open–close',
          durationS: 2,
          playback: 'loop',
          tracks: [
            {
              jointId: 'joint_pivot',
              dof: 0,
              keys: [
                { t: 0, value: 0, easing: 'linear' },
                { t: 1, value: 35, easing: 'ease' }
              ]
            }
          ]
        }
      })
    );
    manager.execute(
      commandFactories.deleteAssemblyComponent({ componentId: 'comp_b' })
    );
    const set = manager.document.assembly!;
    expect(set.joints).toEqual([]);
    expect(set.studies[0]?.tracks).toEqual([]);
    expect(set.positions[0]?.values).toEqual({});
  });

  it('changing a joint kind resets its values and limits', () => {
    const { manager } = assembled();
    manager.execute(
      commandFactories.updateAssemblyJoint({
        jointId: 'joint_pivot',
        kind: 'cylindrical'
      })
    );
    const j = manager.document.assembly!.joints[0]!;
    expect(j.values).toEqual([0, 0]);
    expect(j.limits).toEqual([null, null]);
  });

  it('refuses assembly content on documents older than v54', () => {
    const { manager } = assembled();
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    // Assemblies arrived in v54; later bumps (v56 couplings) leave that be.
    expect(() =>
      normalizeDocument({
        ...saved,
        schemaVersion: 53
      } as unknown as ProjectDocument)
    ).toThrow(/schema v54/);
    const broken = { ...saved, assembly: { components: 'nope' } };
    expect(() => assertStorableDocument(broken)).toThrow(
      UnstorableDocumentError
    );
  });

  it('follows a body that a later feature remade', () => {
    const { manager, a } = assembled();
    const document = structuredClone(manager.document);
    const remade = 'body_remade' as BodyId;
    const feature: FeatureNode = {
      ...(Object.values(document.nodes).find(
        (n) => n.kind === 'feature'
      ) as FeatureNode),
      id: toEntityId('feature_remake'),
      featureId: 'feature_remake' as FeatureNode['featureId'],
      data: { targetBodyId: a } as unknown as FeatureNode['data']
    };
    const body: BodyNode = {
      ...(Object.values(document.nodes).find(
        (n) => n.kind === 'body'
      ) as BodyNode),
      id: toEntityId('node_remade'),
      bodyId: remade,
      featureId: feature.featureId
    };
    document.nodes[feature.id] = feature;
    document.nodes[body.id] = body;
    document.bodyOrder = [...document.bodyOrder, remade];
    expect(assemblyComponentBodies(document).get('comp_a')).toBe(a);
    const live = assemblyComponentBodies(document, (id) => id !== a);
    expect(live.get('comp_a')).toBe(remade);
    expect(
      assemblyComponentBodies(document, () => false).get('comp_a')
    ).toBeNull();
  });

  it('lists the commands for analytics and keeps names out of diagnostics', () => {
    const { manager } = assembled();
    for (const contract of [webGlimpse, workerGlimpse])
      expect(contract.EXPANDED.feature_operation).toEqual(
        expect.arrayContaining([
          'assembly.components.add',
          'assembly.joint.add',
          'assembly.pose.set'
        ])
      );
    manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_b',
        name: 'Secret Blade'
      })
    );
    const bundle = createProjectDiagnosticBundle(
      manager.document,
      { remusVersion: '0', remusCommit: '0' },
      '2026-11-03T00:00:00.000Z'
    );
    expect('assembly' in bundle.document).toBe(false);
    expect(JSON.stringify(bundle)).not.toContain('Secret Blade');
  });
});
