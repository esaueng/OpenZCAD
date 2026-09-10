import { describe, expect, it } from 'vitest';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  createProjectDocument,
  evaluateExpression,
  listFeaturesInOrder,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  composeCommands,
  replayCommands
} from './index';

export const openingRegions = [
  { min: { x: -18, y: -10, z: 0 }, max: { x: 11, y: 43, z: 70 } },
  { min: { x: 11, y: -10, z: 0 }, max: { x: 40, y: 43, z: 70 } }
];
function setup() {
  const root = createProjectDocument('Opening recipe', toUserId('user_recipe'));
  const manager = new CommandManager(root);
  manager.execute(
    commandFactories.importStep({
      name: 'Source',
      artifactId: 'source',
      sourceName: 'source.step',
      stepText: 'ISO-10303-21;'
    })
  );
  const operation = {
    kind: 'add_imported_opening_recipe',
    name: 'Opening',
    localId: 'opened',
    targetBodyId: manager.document.bodyOrder[0],
    sourceWidth: 46,
    editedWidth: 50,
    width: 'opening_width',
    axis: 'x',
    regions: openingRegions
  };
  const proposal = parseCadPatchProposal({
    proposalId: 'opening',
    summary: 'Localized opening',
    assumptions: ['Measured regions'],
    operations: [
      { kind: 'set_parameter', name: 'opening_width', expression: '50' },
      operation
    ]
  });
  return { root, manager, proposal, operation };
}
describe('imported opening recipe', () => {
  it('compiles to ordinary source-preserving history and replays atomically', () => {
    const { root, manager, proposal } = setup();
    const before = manager.document;
    const commands = commandsForCadPatch(before, proposal);
    manager.execute(composeCommands('Opening', commands));
    const features = listFeaturesInOrder(manager.document);
    expect(
      features.filter((f) => f.featureKind === 'imported-step')
    ).toHaveLength(3);
    expect(features.filter((f) => f.featureKind === 'boolean')).toHaveLength(8);
    expect(features.filter((f) => f.featureKind === 'transform')).toHaveLength(
      4
    );
    expect(features.filter((f) => f.featureKind === 'primitive')).toHaveLength(
      2
    );
    expect(
      features
        .filter((f) => f.data.featureKind === 'imported-step')
        .map((f) => f.data)
    ).toEqual([features[0]!.data, features[0]!.data, features[0]!.data]);
    const replayed = replayCommands(root, manager.document.commandLog);
    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);
    manager.undo();
    expect(manager.document.featureOrder).toEqual(before.featureOrder);
    manager.redo();
    expect(manager.document.featureOrder).toEqual(replayed.featureOrder);
    const edited = setParameter(manager.document, {
      name: 'opening_width',
      expression: '50'
    });
    expect(edited.featureOrder).toEqual(replayed.featureOrder);
    const displacements = features.flatMap((f) =>
      f.data.featureKind === 'transform' &&
      typeof f.data.transform.translation.x === 'string'
        ? [f.data.transform.translation.x]
        : []
    );
    expect(
      displacements.map((e) => evaluateExpression(e, { opening_width: 50 }))
    ).toEqual([-2, 2]);
    for (const width of [45, 48, 51])
      for (const expression of displacements)
        expect(() =>
          evaluateExpression(expression, { opening_width: width })
        ).toThrow(/supported values/);
  });
  it('rejects invalid bounds, ranges and changed source bodies before mutation', () => {
    const { manager, proposal, operation } = setup();
    const invalid = {
      ...operation,
      regions: [openingRegions[1], openingRegions[0]]
    };
    const bad = parseCadPatchProposal({
      ...proposal,
      operations: [proposal.operations[0], invalid]
    });
    expect(() => commandsForCadPatch(manager.document, bad)).toThrow(
      /must not overlap/
    );
    expect(() =>
      parseCadPatchProposal({
        ...proposal,
        operations: [{ ...operation, editedWidth: 45 }]
      })
    ).toThrow(/Invalid/);
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: manager.document.bodyOrder[0]!,
        translation: { x: 1, y: 0, z: 0 }
      })
    );
    expect(() => commandsForCadPatch(manager.document, proposal)).toThrow(
      /unmodified/
    );
  });
  it('requires finite explicit supported values', () => {
    expect(evaluateExpression('require_one_of(46,46,50)', {})).toBe(46);
    expect(evaluateExpression('require_one_of(50,46,50)', {})).toBe(50);
    for (const expression of [
      'require_one_of(1)',
      'require_one_of(48,46,50)',
      'require_one_of(1/0,46,50)'
    ])
      expect(() => evaluateExpression(expression, {})).toThrow();
  });
});
