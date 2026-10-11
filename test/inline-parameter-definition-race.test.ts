import { describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import { createProjectDocument, listParameters } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

describe('inline parameter definitions against a moving document', () => {
  it('refuses to overwrite a parameter added by a patch while the definition waited', () => {
    const initial = createProjectDocument(
      'Definition race',
      toUserId('user_definition')
    );
    const definition = commandFactories.setParameter({
      name: 'width',
      expression: '80',
      addOnly: true
    });
    const patch = commandFactories.setParameter({
      name: 'width',
      expression: '120'
    });
    const updated = patch.apply(initial);
    expect(() => definition.apply(updated)).toThrow('width already exists');
    expect(
      listParameters(updated).find((p) => p.name === 'width')?.expression
    ).toBe('120');
    // The same add-only operation succeeds if the patch did not take its name.
    expect(listParameters(definition.apply(initial))[0]?.expression).toBe('80');
  });
});
