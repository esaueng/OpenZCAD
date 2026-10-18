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
import { CommandManager, commandFactories } from '@openzcad/command-system';
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
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(21);
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
});
