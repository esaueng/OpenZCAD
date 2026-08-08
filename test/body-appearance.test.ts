import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  listNodesByKind
} from '@openzcad/document-core';
import {
  BODY_COLOR_METADATA_KEY,
  BODY_OPACITY_METADATA_KEY,
  toUserId
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

function addBox(manager: CommandManager, name: string) {
  manager.execute(
    commandFactories.addPrimitive({
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    })
  );
}

function onlyBodyNode(document: ReturnType<typeof createProjectDocument>) {
  const body = listNodesByKind(document, 'body')[0];
  if (!body) {
    throw new Error('Expected a body node.');
  }
  return body;
}

describe('body appearance', { timeout: 30_000 }, () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => {
    kernel.dispose();
  });

  it('flows color and opacity from metadata to the render projection', async () => {
    const base = createProjectDocument('Appearance', toUserId('user_appear'));
    const manager = new CommandManager(base);
    addBox(manager, 'Tinted box');
    const bodyNode = onlyBodyNode(manager.document);

    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: bodyNode.id,
          metadata: {
            [BODY_COLOR_METADATA_KEY]: '#4da3ff',
            [BODY_OPACITY_METADATA_KEY]: 0.4
          }
        },
        'Set Tinted box appearance'
      )
    );

    const edited = onlyBodyNode(manager.document);
    expect(edited.metadata?.[BODY_COLOR_METADATA_KEY]).toBe('#4da3ff');
    expect(edited.metadata?.[BODY_OPACITY_METADATA_KEY]).toBe(0.4);

    const derived = await kernel.syncDocument(manager.document);
    const representation = derived.bodyRepresentations[bodyNode.bodyId];
    expect(representation?.color).toBe('#4da3ff');
    expect(representation?.opacity).toBe(0.4);

    const replayed = replayCommands(base, manager.document.commandLog);
    const replayedNode = onlyBodyNode(replayed);
    expect(replayedNode.metadata?.[BODY_COLOR_METADATA_KEY]).toBe('#4da3ff');
    expect(replayedNode.metadata?.[BODY_OPACITY_METADATA_KEY]).toBe(0.4);

    manager.undo();
    expect(
      onlyBodyNode(manager.document).metadata?.[BODY_OPACITY_METADATA_KEY]
    ).toBeUndefined();
    manager.redo();
    expect(
      onlyBodyNode(manager.document).metadata?.[BODY_OPACITY_METADATA_KEY]
    ).toBe(0.4);
  });

  it('returns to the opaque fast path when opacity is cleared', async () => {
    const manager = new CommandManager(
      createProjectDocument('Opacity reset', toUserId('user_opaque'))
    );
    addBox(manager, 'Faded box');
    const bodyNode = onlyBodyNode(manager.document);

    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: bodyNode.id,
          metadata: { [BODY_OPACITY_METADATA_KEY]: 0.25 }
        },
        'Fade Faded box'
      )
    );
    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: bodyNode.id,
          metadata: { [BODY_OPACITY_METADATA_KEY]: null }
        },
        'Reset Faded box opacity'
      )
    );

    expect(
      onlyBodyNode(manager.document).metadata?.[BODY_OPACITY_METADATA_KEY]
    ).toBeUndefined();
    const derived = await kernel.syncDocument(manager.document);
    expect(
      derived.bodyRepresentations[bodyNode.bodyId]?.opacity
    ).toBeUndefined();
  });

  it('clamps out-of-range opacity and ignores non-numeric values', async () => {
    const manager = new CommandManager(
      createProjectDocument('Opacity clamp', toUserId('user_clamp'))
    );
    addBox(manager, 'Clamped box');
    const bodyNode = onlyBodyNode(manager.document);

    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: bodyNode.id,
          metadata: { [BODY_OPACITY_METADATA_KEY]: 1.7 }
        },
        'Overbright'
      )
    );
    let derived = await kernel.syncDocument(manager.document);
    expect(
      derived.bodyRepresentations[bodyNode.bodyId]?.opacity
    ).toBeUndefined();

    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: bodyNode.id,
          metadata: { [BODY_OPACITY_METADATA_KEY]: -0.5 }
        },
        'Negative'
      )
    );
    derived = await kernel.syncDocument(manager.document);
    expect(derived.bodyRepresentations[bodyNode.bodyId]?.opacity).toBe(0);

    manager.execute(
      commandFactories.setNodeMetadata(
        {
          nodeId: bodyNode.id,
          metadata: { [BODY_OPACITY_METADATA_KEY]: 'half' }
        },
        'Non-numeric'
      )
    );
    derived = await kernel.syncDocument(manager.document);
    expect(
      derived.bodyRepresentations[bodyNode.bodyId]?.opacity
    ).toBeUndefined();
  });
});
