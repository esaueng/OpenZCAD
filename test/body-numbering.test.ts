import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  replayCommands,
  type AnyCommand
} from '@openzcad/command-system';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createBodyFeatureIds,
  createProjectDocument,
  extrudeSketch,
  loftSections,
  normalizeDocument,
  numberedBodyName,
  renameNode,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

/**
 * F18 of the 1 October 2026 design review: "Box Body" twice in the body
 * list, "Box Body" surviving a union, and two identical rows in the Union
 * card. New bodies are numbered at creation; a document already on disk is
 * never renamed, because any rewrite no user made reads as a sync conflict.
 */

const user = toUserId('user_body_numbering');

function names(document: ProjectDocument): string[] {
  return document.bodyOrder.map(
    (bodyId) =>
      Object.values(document.nodes).find(
        (node) => node.kind === 'body' && node.bodyId === bodyId
      )!.name
  );
}

function box(document: ProjectDocument, name: string, numbered = true) {
  return addPrimitiveFeature(document, {
    name,
    ...(numbered ? { bodyName: numberedBodyName(document, name) } : {}),
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
}

describe('numberedBodyName', () => {
  it('numbers each feature name from 1, independently', () => {
    let document = createProjectDocument('Numbers', user);
    expect(numberedBodyName(document, 'Box')).toBe('Box 1');
    document = box(document, 'Box');
    document = box(document, 'Box');
    document = box(document, 'Cylinder');
    expect(names(document)).toEqual(['Box 1', 'Box 2', 'Cylinder 1']);
    expect(numberedBodyName(document, 'Box')).toBe('Box 3');
    expect(numberedBodyName(document, ' Extrude ')).toBe('Extrude 1');
  });

  it('never reuses a number still held by a body, renamed or consumed', () => {
    let document = box(box(createProjectDocument('Gaps', user), 'Box'), 'Box');
    const first = Object.values(document.nodes).find(
      (node) => node.kind === 'body' && node.name === 'Box 1'
    )!;
    document = renameNode(document, { nodeId: first.id, name: 'Base plate' });
    // "Box 1" is free again, but the next box follows the highest number.
    expect(numberedBodyName(document, 'Box')).toBe('Box 3');
  });

  it('keeps a name that already ends in a free number', () => {
    let document = createProjectDocument('Typed', user);
    expect(numberedBodyName(document, 'Bracket 2')).toBe('Bracket 2');
    document = box(document, 'Bracket 2');
    expect(numberedBodyName(document, 'Bracket 2')).toBe('Bracket 2 1');
    expect(numberedBodyName(document, '')).toBe('Body 1');
  });
});

describe('body names at creation', () => {
  it('keeps the legacy name for a command recorded before numbering', () => {
    const document = box(createProjectDocument('Legacy', user), 'Box', false);
    expect(names(document)).toEqual(['Box Body']);
  });

  it('keeps a joined or cut target name, and numbers a new extrude', () => {
    let document = box(createProjectDocument('Extrude', user), 'Box');
    const plate = document.bodyOrder[0]!;
    const sketch = addSketchFeature(document, {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 5,
          centerY: 5
        }
      ]
    });
    document = sketch.document;
    const extrude = (
      base: ProjectDocument,
      operation: 'new-body' | 'add' | 'cut',
      numbered = true
    ) =>
      extrudeSketch(base, {
        name: 'Extrude',
        ...(numbered ? { bodyName: numberedBodyName(base, 'Extrude') } : {}),
        sketchId: sketch.sketchId,
        distance: 3,
        operation,
        ...(operation === 'new-body' ? {} : { targetBodyId: plate })
      }).document;
    expect(names(extrude(document, 'new-body')).at(-1)).toBe('Extrude 1');
    expect(names(extrude(document, 'add')).at(-1)).toBe('Box 1');
    expect(names(extrude(document, 'cut')).at(-1)).toBe('Box 1');
    expect(names(extrude(document, 'add', false)).at(-1)).toBe('Extrude Body');
  });

  it('numbers a loft, which has no source body to be named after', () => {
    const base = createProjectDocument('Loft', user);
    const { document } = loftSections(base, {
      name: 'Loft',
      bodyName: numberedBodyName(base, 'Loft'),
      sections: [],
      mode: 'ruled'
    });
    expect(names(document)).toEqual(['Loft 1']);
    expect(
      names(
        loftSections(base, { name: 'Loft', sections: [], mode: 'ruled' })
          .document
      )
    ).toEqual(['Loft']);
  });

  it('keeps the first input name through a union, not two "Box Body"s', () => {
    let document = box(box(createProjectDocument('Union', user), 'Box'), 'Box');
    const [a, b] = document.bodyOrder;
    document = commandFactories
      .booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [b!, a!]
      })
      .apply(document);
    expect(names(document)).toEqual(['Box 1', 'Box 2', 'Box 2']);
  });

  it('numbers the bodies an assistant patch creates', () => {
    const primitive = (name: string, localId: string) =>
      ({
        kind: 'add_primitive',
        name,
        localId,
        primitiveKind: 'box',
        dimensions: {
          width: 10,
          height: 10,
          depth: 10,
          radius: null,
          bottomRadius: null,
          topRadius: null,
          majorRadius: null,
          minorRadius: null
        }
      }) as const;
    const proposal: CadPatchProposal = {
      proposalId: 'proposal_numbered_boxes',
      summary: 'Two boxes.',
      assumptions: [],
      operations: [primitive('Box', 'a'), primitive('Box', 'b')]
    };
    const manager = new CommandManager(
      box(createProjectDocument('Assistant', user), 'Box')
    );
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, proposal)
    );
    expect(names(manager.document)).toEqual(['Box 1', 'Box 2', 'Box 3']);
  });
});

describe('a stored document keeps its stored names', () => {
  function legacyDocument(): ProjectDocument {
    const manager = new CommandManager(createProjectDocument('Stored', user));
    const ids = [createBodyFeatureIds(), createBodyFeatureIds()];
    const commands: AnyCommand[] = ids.map((bodyIds) =>
      // Exactly what every command recorded before numbering carries.
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 },
        ids: bodyIds
      })
    );
    commands.push(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: ids.map((bodyIds) => bodyIds.bodyId)
      })
    );
    manager.runTransaction('Bracket', commands);
    return manager.document;
  }

  it('opens, normalizes and replays to the same names, byte for byte', () => {
    const stored = legacyDocument();
    expect(names(stored)).toEqual(['Box Body', 'Box Body', 'Box Body']);
    // What a reopen does to the bytes on disk.
    const opened = normalizeDocument(
      JSON.parse(JSON.stringify(stored)) as ProjectDocument
    );
    expect(withoutDerivedProjection(opened)).toEqual(
      withoutDerivedProjection(stored)
    );
    // A replay of its command log, as collaboration and recovery do.
    const replayed = replayCommands(
      createProjectDocument('Stored', user),
      stored.commandLog
    );
    expect(names(replayed)).toEqual(['Box Body', 'Box Body', 'Box Body']);
  });

  it('numbers only what is added to it afterwards', () => {
    const stored = legacyDocument();
    const next = box(stored, 'Box');
    expect(names(next)).toEqual(['Box Body', 'Box Body', 'Box Body', 'Box 1']);
  });

  it('replays a numbered command to the name it was created with', () => {
    const manager = new CommandManager(createProjectDocument('Replay', user));
    for (const _ of [0, 1]) {
      manager.runTransaction('Box', [
        commandFactories.addPrimitive({
          name: 'Box',
          bodyName: numberedBodyName(manager.document, 'Box'),
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        })
      ]);
    }
    const replayed = replayCommands(
      createProjectDocument('Replay', user),
      manager.document.commandLog
    );
    expect(names(replayed)).toEqual(['Box 1', 'Box 2']);
  });
});
