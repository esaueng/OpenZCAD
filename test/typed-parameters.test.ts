import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  composeCommands,
  isParameterRetype
} from '@openzcad/command-system';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId
} from '@openzcad/shared';

/**
 * F05 Stage 1a: a typed length parameter mixes with suffixed lengths, the
 * exact build reads the result like any other value, and changing or
 * clearing the quantity is one undoable step.
 */
describe('typed parameters through the exact build (F05)', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  it('builds a box from width + 5 mm and follows the parameter', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(33);
    let document = createProjectDocument('Typed', toUserId('user_f05'));
    document = setParameter(document, {
      name: 'width',
      expression: '10',
      quantity: 'length'
    });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'width + 5 mm', height: '1 cm', depth: 10 }
    });
    const [blockId] = document.bodyOrder as [BodyId];
    const manager = new CommandManager(document);
    const size = async () => {
      const derived = await adapter.syncDocument(manager.document);
      expect(derived.warnings).toEqual([]);
      const { min, max } = derived.bodyRepresentations[blockId]!.bbox;
      return [max.x - min.x, max.y - min.y].map(
        (value) => Math.round(value * 1e6) / 1e6
      );
    };
    expect(await size()).toEqual([15, 10]);

    manager.execute(
      commandFactories.setParameter({ name: 'width', expression: '1 in' })
    );
    expect(await size()).toEqual([30.4, 10]);

    // Clearing the quantity would leave `width + 5 mm` adding a bare number
    // to a length: refused, and nothing changes.
    expect(() =>
      manager.execute(
        commandFactories.setParameter({
          name: 'width',
          expression: '1 in',
          quantity: null
        })
      )
    ).toThrow(/uses "width \+ 5 mm": Incompatible dimensions/);
    expect(await size()).toEqual([30.4, 10]);

    manager.undo();
    expect(await size()).toEqual([15, 10]);
  });

  it('refuses a command that feeds a typed angle to a length field', () => {
    const document = setParameter(
      createProjectDocument('Misuse', toUserId('user_f05')),
      { name: 'tilt', expression: '30', quantity: 'angle' }
    );
    const manager = new CommandManager(document);
    expect(() =>
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 'tilt', height: 10, depth: 10 }
        })
      )
    ).toThrow(/uses "tilt": .*expected a length/);
    expect(manager.document.bodyOrder).toEqual([]);
  });

  it('refuses to build a feature that a document feeds a typed angle as a length', async () => {
    // Authored outside the command path (an older client, the API): the
    // build refuses the feature by name instead of building 30 mm.
    let document = setParameter(
      createProjectDocument('Misuse build', toUserId('user_f05')),
      { name: 'tilt', expression: '30', quantity: 'angle' }
    );
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'tilt', height: 10, depth: 10 }
    });
    const [blockId] = document.bodyOrder as [BodyId];
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings.join('\n')).toMatch(
      /Feature "Block": .*uses "tilt": .*expected a length/
    );
    expect(derived.bodyRepresentations[blockId]).toBeUndefined();
  });

  it('replays a feature when only a parameter quantity changes', async () => {
    // A collaborator's document retypes `a` without touching any value:
    // the cached build of the box must not be reused.
    let document = setParameter(
      createProjectDocument('Quantity cache', toUserId('user_f05')),
      { name: 'a', expression: '20' }
    );
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'a', height: 10, depth: 10 }
    });
    const [blockId] = document.bodyOrder as [BodyId];
    const first = await adapter.syncDocument(document);
    expect(first.bodyRepresentations[blockId]).toBeDefined();
    const retyped = structuredClone(document);
    for (const node of Object.values(retyped.nodes)) {
      if (node.kind === 'parameter' && node.name === 'a')
        node.quantity = 'angle';
    }
    retyped.version += 1;
    const second = await adapter.syncDocument(retyped);
    expect(second.warnings.join('\n')).toMatch(/Feature "Block": .*uses "a"/);
    expect(second.bodyRepresentations[blockId]).toBeUndefined();
  });

  it('keeps a typed parameter typed across a proposal that renames it', () => {
    const document = setParameter(
      createProjectDocument('Rename typed', toUserId('user_f05')),
      { name: 'w', expression: '10', quantity: 'length' }
    );
    const commands = commandsForCadPatch(
      document,
      parseCadPatchProposal({
        proposalId: 'p1',
        summary: 'Rename and use',
        assumptions: [],
        operations: [
          { kind: 'rename_parameter', name: 'w', newName: 'width' },
          { kind: 'set_parameter', name: 'outer', expression: 'width + 5 mm' }
        ]
      })
    );
    const manager = new CommandManager(document);
    manager.execute(composeCommands('Apply proposal', commands));
    expect(
      manager.document.nodes &&
        Object.values(manager.document.nodes).find(
          (node) => node.kind === 'parameter' && node.name === 'width'
        )
    ).toMatchObject({ quantity: 'length' });
  });
});

describe('typed parameters at transaction end', () => {
  it('refuses a transaction whose end state mistypes a parameter', () => {
    const manager = new CommandManager(
      createProjectDocument('Typed end state', toUserId('user_f05_end'))
    );
    const before = manager.document;
    // `length` reads `later` before it exists; the second command makes it
    // an angle, so the length parameter ends up holding an angle.
    expect(() =>
      manager.runTransaction('Add both', [
        commandFactories.setParameter({
          name: 'length',
          expression: 'later',
          quantity: 'length'
        }),
        commandFactories.setParameter({
          name: 'later',
          expression: '30',
          quantity: 'angle'
        })
      ])
    ).toThrow(/Parameter "length" uses "later"/);
    expect(manager.document).toBe(before);
  });
});

describe('Tweak undo and parameter types', () => {
  it('keeps a retype out of Tweak undo while a value edit stays in it', () => {
    const manager = new CommandManager(
      createProjectDocument('Tweak retype', toUserId('user_f05_tweak'))
    );
    manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '10' })
    );
    expect(manager.undoIsParameterOnly).toBe(true);
    // Retyping is a Build edit: Tweak hides the picker, so undo there may
    // not retype either.
    manager.execute(
      commandFactories.setParameter({
        name: 'w',
        expression: '10',
        quantity: 'length'
      })
    );
    expect(manager.undoIsParameterOnly).toBe(false);
    expect(manager.canUndoIn(true)).toBe(false);
    manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '12' })
    );
    expect(manager.canUndoIn(true)).toBe(true);
  });

  it('names a typed parameter set as a retype for the edit guards', () => {
    expect(
      isParameterRetype(
        commandFactories.setParameter({ name: 'w', expression: '1' })
      )
    ).toBe(false);
    expect(
      isParameterRetype(
        commandFactories.setParameter({
          name: 'w',
          expression: '1',
          quantity: null
        })
      )
    ).toBe(true);
  });
});
