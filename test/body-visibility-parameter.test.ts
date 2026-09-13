import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  configureParameterToggle,
  createProjectDocument,
  deleteParameter,
  getParameterHiddenBodyIds,
  getParameterScope,
  listParameters,
  normalizeDocument,
  renameParameter,
  setParameter
} from '@openzcad/document-core';
import {
  commandFactories,
  CommandManager,
  replayCommands
} from '@openzcad/command-system';
import { toBodyId, toUserId } from '@openzcad/shared';

function fixture() {
  const first = addPrimitiveFeature(
    createProjectDocument('Toggle', toUserId('test')),
    {
      name: 'Holder',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 30 }
    }
  );
  const second = addPrimitiveFeature(first, {
    name: 'Text',
    primitiveKind: 'box',
    dimensions: { width: 1, height: 4, depth: 12 }
  });
  return {
    document: second,
    bodyId: second.bodyOrder[1]!,
    holderId: first.bodyOrder[0]!
  };
}

describe('on/off body parameters', () => {
  it('keeps old documents numeric and controls several bodies with one switch', () => {
    const { document, bodyId, holderId } = fixture();
    expect(listParameters(normalizeDocument(document))).toEqual([]);
    const on = configureParameterToggle(document, {
      name: 'show_text',
      bodyIds: [bodyId, holderId, bodyId]
    });
    expect(listParameters(on)[0]?.toggle?.bodyIds).toEqual([bodyId, holderId]);
    expect(getParameterScope(on).scope.show_text).toBe(1);
    expect([...getParameterHiddenBodyIds(on)]).toEqual([]);
    const off = setParameter(on, { name: 'show_text', expression: '0' });
    expect([...getParameterHiddenBodyIds(off)]).toEqual([bodyId, holderId]);
    expect(off.featureOrder).toEqual(document.featureOrder);
    expect(off.bodyOrder).toEqual(document.bodyOrder);
    expect(listParameters(document)).toEqual([]);
    expect(() =>
      setParameter(off, { name: 'show_text', expression: '2' })
    ).toThrow(/0.*1/);
    expect(() =>
      setParameter(off, { name: 'show_text', expression: 'unknown' })
    ).toThrow(/0.*1/);
  });

  it('retains bindings through rename, JSON reopen, scalar edits and undo/redo', () => {
    const { document, bodyId } = fixture();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.configureParameterToggle({
        name: 'show_text',
        bodyIds: [bodyId]
      })
    );
    manager.execute(
      commandFactories.setParameter({ name: 'show_text', expression: '0' })
    );
    expect(getParameterHiddenBodyIds(manager.document).has(bodyId)).toBe(true);
    manager.undo();
    expect(getParameterHiddenBodyIds(manager.document).has(bodyId)).toBe(false);
    manager.redo();
    const renamed = renameParameter(manager.document, {
      name: 'show_text',
      newName: 'lettering'
    });
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(renamed)) as typeof renamed
    );
    expect(getParameterHiddenBodyIds(reopened).has(bodyId)).toBe(true);
    expect(listParameters(reopened)[0]?.name).toBe('lettering');
    expect(
      getParameterHiddenBodyIds(
        deleteParameter(reopened, { name: 'lettering' })
      ).size
    ).toBe(0);
  });

  it('replays toggle configuration separately from edits admitted in Tweak', () => {
    const { document, bodyId } = fixture();
    const manager = new CommandManager(document);
    const command = commandFactories.configureParameterToggle({
      name: 'show_text',
      bodyIds: [bodyId]
    });
    expect(command.kind).toBe('parameter.configure-toggle');
    manager.execute(command);
    manager.execute(
      commandFactories.setParameter({ name: 'show_text', expression: '0' })
    );
    const replay = replayCommands(document, manager.document.commandLog);
    expect(listParameters(replay)).toEqual(listParameters(manager.document));
    expect(getParameterHiddenBodyIds(replay).has(bodyId)).toBe(true);
  });

  it('refuses missing bodies, duplicate ownership and numeric-name collisions', () => {
    const { document, bodyId } = fixture();
    expect(() =>
      configureParameterToggle(document, {
        name: 'show_text',
        bodyIds: [toBodyId('missing')]
      })
    ).toThrow(/does not exist/);
    const on = configureParameterToggle(document, {
      name: 'show_text',
      bodyIds: [bodyId]
    });
    expect(() =>
      configureParameterToggle(on, { name: 'another', bodyIds: [bodyId] })
    ).toThrow(/already controlled/);
    const numeric = setParameter(document, { name: 'width', expression: '10' });
    expect(() =>
      configureParameterToggle(numeric, { name: 'width', bodyIds: [] })
    ).toThrow(/numeric parameter/);
  });
});
