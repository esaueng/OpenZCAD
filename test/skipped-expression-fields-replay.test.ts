import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  typedParameterMisuse
} from '@openzcad/document-core';
import {
  toUserId,
  type DocumentNode,
  type FeatureData,
  type ParameterKind,
  type ProjectDocument,
  type SerializedCommand,
  type SketchConstraintData
} from '@openzcad/shared';

/**
 * Review of #1962: the I03 follow-up made four skipped expression fields
 * visible to F05 (a tapped hole's thread length and clearance, a sketch
 * pattern's spacing and step angle). A command log recorded before that
 * could retype or delete a parameter only those fields read; replaying it
 * must keep the recorded edit and leave the build to name the feature,
 * rather than throw before a document exists.
 */

function onlyNode<K extends DocumentNode['kind']>(
  document: ProjectDocument,
  kind: K
): Extract<DocumentNode, { kind: K }> {
  const nodes = Object.values(document.nodes).filter(
    (node): node is Extract<DocumentNode, { kind: K }> => node.kind === kind
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

const blank = () =>
  createProjectDocument('Replay skipped fields', toUserId('user_i03_replay'));

/** A tapped hole reading `adjust` in `field`, hand-placed as a stored document holds it. */
function tappedHole(field: 'length' | 'clearance'): ProjectDocument {
  const next = addPrimitiveFeature(blank(), {
    name: 'Hole',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const feature = onlyNode(next, 'feature');
  feature.data = {
    featureKind: 'hole',
    targetBodyId: 'body',
    faceHash: 0,
    style: 'simple',
    diameter: '5',
    depthMode: 'blind',
    depth: 10,
    position: { u: 0, v: 0 },
    tapped: {
      length: '6',
      clearance: '0.1',
      [field]: 'adjust',
      cosmetic: false
    }
  } as unknown as FeatureData;
  return next;
}

/** A sketch whose pattern reads `adjust` as its spacing or step angle. */
function patternedSketch(field: 'spacing' | 'stepDeg'): ProjectDocument {
  const next = addSketchFeature(blank(), {
    name: 'Sketch',
    objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
  }).document;
  const layout =
    field === 'spacing'
      ? { kind: 'linear', direction: 'c', spacing: 'adjust' }
      : {
          kind: 'circular',
          pivot: { objectId: 'c', point: 'start' },
          stepDeg: 'adjust',
          orientation: 'rotate'
        };
  onlyNode(next, 'sketch').constraints = [
    {
      constraintId: 'pattern-0' as never,
      data: {
        constraintKind: 'pattern',
        source: 'a',
        instances: [{ objectId: 'b', step: 1 }],
        layout
      } as SketchConstraintData
    }
  ];
  return next;
}

const cases: {
  field: string;
  initial: () => ProjectDocument;
  owner: string;
  wrong: { expression: string; quantity: ParameterKind };
}[] = [
  {
    field: 'tapped.length',
    initial: () => tappedHole('length'),
    owner: 'Feature "Hole"',
    wrong: { expression: '6 deg', quantity: 'angle' }
  },
  {
    field: 'tapped.clearance',
    initial: () => tappedHole('clearance'),
    owner: 'Feature "Hole"',
    wrong: { expression: '0.1 deg', quantity: 'angle' }
  },
  {
    field: 'layout.spacing',
    initial: () => patternedSketch('spacing'),
    owner: 'Sketch "Sketch"',
    wrong: { expression: '0.1 deg', quantity: 'angle' }
  },
  {
    field: 'layout.stepDeg',
    initial: () => patternedSketch('stepDeg'),
    owner: 'Sketch "Sketch"',
    wrong: { expression: '30 mm', quantity: 'length' }
  }
];

const set = (payload: Record<string, unknown>): SerializedCommand =>
  ({ kind: 'parameter.set', payload }) as SerializedCommand;

describe('replaying a log recorded before the skipped fields were checked', () => {
  it.each(cases)(
    'keeps a recorded retype read by $field and lets the build name the feature',
    ({ initial, owner, wrong }) => {
      const document = initial();
      // The old log: `adjust` untyped, then retyped to the wrong quantity.
      const log = [
        set({ name: 'adjust', expression: '1' }),
        set({ name: 'adjust', ...wrong })
      ];
      // Authoring the same retype today is refused.
      const manager = new CommandManager(document);
      manager.execute(commandFactories.setParameter(log[0]!.payload as never));
      expect(() =>
        manager.execute(commandFactories.setParameter(log[1]!.payload as never))
      ).toThrow(/uses "adjust"/);

      const replayed = replayCommands(document, log);
      const adjust = Object.values(replayed.nodes).find(
        (node) => node.kind === 'parameter' && node.name === 'adjust'
      );
      expect(adjust).toMatchObject({
        expression: wrong.expression,
        quantity: wrong.quantity
      });
      expect(replayed.commandLog).toHaveLength(2);
      const misuse = typedParameterMisuse(replayed);
      expect(misuse).toHaveLength(1);
      expect(misuse[0]!.featureId).toBe(
        onlyNode(replayed, 'feature').featureId
      );
      expect(misuse[0]!.message).toMatch(new RegExp(`^${owner} uses "adjust"`));
    }
  );

  it.each(cases)(
    'keeps a recorded delete of a parameter only $field reads',
    ({ initial }) => {
      const document = initial();
      const log: SerializedCommand[] = [
        set({ name: 'adjust', expression: '1' }),
        {
          kind: 'parameter.delete',
          payload: { name: 'adjust' }
        } as SerializedCommand
      ];
      const manager = new CommandManager(document);
      manager.execute(commandFactories.setParameter(log[0]!.payload as never));
      expect(() =>
        manager.execute(commandFactories.deleteParameter({ name: 'adjust' }))
      ).toThrow(/Cannot delete parameter "adjust"/);

      const replayed = replayCommands(document, log);
      expect(
        Object.values(replayed.nodes).some(
          (node) => node.kind === 'parameter' && node.name === 'adjust'
        )
      ).toBe(false);
      expect(replayed.commandLog).toHaveLength(2);
    }
  );
});
