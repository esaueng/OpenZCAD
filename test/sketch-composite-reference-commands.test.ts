import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchComposite,
  addSketchFeature,
  addSketchReferenceDimension,
  createProjectDocument,
  deleteSketchObject,
  findSketch,
  normalizeDocument,
  referenceDimensionObjectIds
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  createSketchCompositeCornerTarget,
  createSketchCompositeSideTarget,
  documentNodesWithHistory,
  isSketchCompositeCornerTarget,
  resolveSketchReferenceDimension,
  toUserId,
  type DocumentChange,
  type ProjectDocument,
  type SerializedCommand,
  type SketchComposite,
  type SketchReferenceDimensionData
} from '@openzcad/shared';

function fixture() {
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    construction = false
  ) => ({ objectKind: 'line' as const, x1, y1, x2, y2, construction });
  const f = addSketchFeature(
    createProjectDocument('Composite references', toUserId('user_test')),
    {
      name: 'Centre rectangle',
      plane: 'XY',
      objects: [
        line(0, 0, 20, 0),
        line(20, 0, 20, 12),
        line(20, 12, 0, 12),
        line(0, 12, 0, 0),
        line(0, 0, 20, 12, true),
        line(20, 0, 0, 12, true),
        line(0, 0, 20, 12, true)
      ]
    }
  );
  const ids = findSketch(f.document, f.sketchId)!.objectIds;
  const added = addSketchComposite(f.document, {
    sketchId: f.sketchId,
    composite: {
      compositeKind: 'rectangle',
      method: 'center',
      edgeIds: ids.slice(0, 4),
      helperIds: ids.slice(4, 6)
    }
  });
  const composite = findSketch(added.document, f.sketchId)!.composites![0]!;
  return { ...f, document: added.document, composite, ids };
}

function distance(composite: SketchComposite): SketchReferenceDimensionData {
  return {
    dimensionKind: 'distance',
    distanceMode: 'horizontal',
    a: createSketchCompositeCornerTarget(composite, 0),
    b: createSketchCompositeCornerTarget(composite, 1)
  };
}

function managerWithReference(
  kind: 'projected-distance' | 'distance' | 'angle' = 'projected-distance'
) {
  const f = fixture();
  const manager = new CommandManager(f.document);
  const data: SketchReferenceDimensionData =
    kind === 'angle'
      ? {
          dimensionKind: 'angle',
          a: createSketchCompositeSideTarget(f.composite, 0),
          b: createSketchCompositeSideTarget(f.composite, 1)
        }
      : distance(f.composite);
  if (kind === 'distance' && data.dimensionKind === 'distance')
    delete data.distanceMode;
  const command = commandFactories.addSketchReferenceDimension({
    sketchId: f.sketchId,
    data
  });
  manager.execute(command);
  return { ...f, manager, annotationId: command.payload.ids!.annotationId };
}

function withCarrierVersion(
  document: ProjectDocument,
  version: number | undefined
): ProjectDocument {
  const saved = structuredClone(document);
  if (version === undefined) Reflect.deleteProperty(saved, 'schemaVersion');
  else saved.schemaVersion = version as typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
  return saved;
}

function expectOldCompositeCarrierRefused(
  document: ProjectDocument,
  carrier: string
) {
  const before = JSON.stringify(document);
  const upgrade =
    /Composite reference targets require project schema v36 or newer/;
  expect(() => normalizeDocument(document), carrier).toThrow(upgrade);
  expect(() => new CommandManager(document), carrier).toThrow(upgrade);
  expect(() => replayCommands(document, []), carrier).toThrow(upgrade);
  expect(JSON.stringify(document), carrier).toBe(before);
}

describe('S04 composite reference commands', () => {
  it('retains named corner and side targets through replay, placement and undo/redo', () => {
    const f = managerWithReference();
    f.manager.execute(
      commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'angle',
          a: createSketchCompositeSideTarget(f.composite, 0),
          b: f.ids[1]!
        }
      })
    );
    f.manager.execute(
      commandFactories.setSketchReferenceLabelPosition({
        sketchId: f.sketchId,
        annotationId: f.annotationId,
        position: { x: 3, y: -2 }
      })
    );
    const expected = structuredClone(
      findSketch(f.manager.document, f.sketchId)!
    );
    const commands = structuredClone(f.manager.document.commandLog);
    const replayed = replayCommands(f.document, commands);
    expect(findSketch(replayed, f.sketchId)).toEqual(expected);
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(f.manager.document)) as ProjectDocument
    );
    expect(findSketch(reopened, f.sketchId)).toEqual(expected);
    f.manager.undo();
    f.manager.undo();
    f.manager.undo();
    expect(findSketch(f.manager.document, f.sketchId)).toEqual(
      findSketch(f.document, f.sketchId)
    );
    f.manager.redo();
    f.manager.redo();
    f.manager.redo();
    expect(findSketch(f.manager.document, f.sketchId)).toEqual(expected);
  });

  it.each([0, 1, 2, 3, 4, 5])(
    'protects member %i until its composite annotation is explicitly removed',
    (index) => {
      const f = managerWithReference();
      const before = JSON.stringify(f.manager.document);
      expect(() =>
        f.manager.execute(
          commandFactories.deleteSketchObject({
            sketchId: f.sketchId,
            objectId: f.ids[index]!
          })
        )
      ).toThrow(/Delete the reference dimensions first/);
      expect(JSON.stringify(f.manager.document)).toBe(before);
      f.manager.execute(
        commandFactories.deleteSketchReferenceDimension({
          sketchId: f.sketchId,
          annotationId: f.annotationId
        })
      );
      f.manager.execute(
        commandFactories.deleteSketchObject({
          sketchId: f.sketchId,
          objectId: f.ids[index]!
        })
      );
      expect(
        findSketch(f.manager.document, f.sketchId)!.composites
      ).toBeUndefined();
      f.manager.undo();
      f.manager.undo();
      expect(findSketch(f.manager.document, f.sketchId)!.composites).toEqual([
        f.composite
      ]);
      expect(
        findSketch(f.manager.document, f.sketchId)!.referenceDimensions![0]!
          .annotationId
      ).toBe(f.annotationId);
    }
  );

  it('protects captured and current owner members even when topology is unresolved', () => {
    const f = managerWithReference();
    const changed = structuredClone(f.manager.document);
    const sketch = findSketch(changed, f.sketchId)!;
    sketch.composites![0]!.helperIds![0] = f.ids[6]!;
    const saved = normalizeDocument(changed);
    const objects = new Map(
      sketch.objectIds.flatMap((id) => {
        const node = saved.nodes[id];
        return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
      })
    );
    expect(
      resolveSketchReferenceDimension(
        objects,
        sketch.referenceDimensions![0]!,
        (value) => (typeof value === 'number' ? value : undefined),
        sketch.composites
      )
    ).toMatchObject({ status: 'unresolved' });
    const dependents = referenceDimensionObjectIds(
      sketch.referenceDimensions![0]!.data,
      sketch.composites
    );
    expect(dependents).toEqual(expect.arrayContaining(f.ids));
    for (const objectId of [f.ids[4]!, f.ids[6]!])
      expect(() =>
        deleteSketchObject(saved, { sketchId: f.sketchId, objectId })
      ).toThrow(/Delete the reference dimensions first/);
    const withoutOwner = structuredClone(saved);
    delete findSketch(withoutOwner, f.sketchId)!.composites;
    expect(() => normalizeDocument(withoutOwner)).not.toThrow();
    expect(() =>
      deleteSketchObject(withoutOwner, {
        sketchId: f.sketchId,
        objectId: f.ids[4]!
      })
    ).toThrow(/Delete the reference dimensions first/);
  });

  it('captures independent document, command and replay topology snapshots', () => {
    const f = fixture();
    const data = distance(f.composite);
    if (
      data.dimensionKind !== 'distance' ||
      !isSketchCompositeCornerTarget(data.a)
    )
      throw new Error('Expected composite corner');
    const expected = structuredClone(data);
    const command = commandFactories.addSketchReferenceDimension({
      sketchId: f.sketchId,
      data
    });
    data.a.topology.edgeIds.reverse();
    const manager = new CommandManager(f.document);
    manager.execute(command);
    const before = structuredClone(manager.document);
    const payload = command.payload.data;
    if (
      payload.dimensionKind !== 'distance' ||
      !isSketchCompositeCornerTarget(payload.a)
    )
      throw new Error('Expected captured corner');
    payload.a.topology.edgeIds.reverse();
    expect(manager.document).toEqual(before);
    expect(
      findSketch(manager.document, f.sketchId)!.referenceDimensions![0]!.data
    ).toEqual(expected);
    const replayed = replayCommands(f.document, manager.document.commandLog);
    expect(findSketch(replayed, f.sketchId)).toEqual(
      findSketch(before, f.sketchId)
    );

    const directData = distance(f.composite);
    const added = addSketchReferenceDimension(f.document, {
      sketchId: f.sketchId,
      data: directData
    });
    if (
      directData.dimensionKind !== 'distance' ||
      !isSketchCompositeCornerTarget(directData.a)
    )
      throw new Error('Expected direct corner');
    directData.a.topology.edgeIds.reverse();
    expect(
      findSketch(added.document, f.sketchId)!.referenceDimensions![0]!.data
    ).toEqual(expected);
  });

  describe.each(['distance', 'angle'] as const)(
    '%s composite reference schema boundary',
    (kind) => {
      it.each([31, 32, 33, 34, 35, undefined])(
        'refuses every readable pre-v36 carrier at schema %s without rewriting',
        (version) => {
          for (const carrier of [
            'current annotation',
            'undo node',
            'redo node',
            'undo node map',
            'redo node map',
            'current nested log',
            'undo value log',
            'redo value log',
            'undo splice log',
            'redo splice log'
          ] as const) {
            const f = managerWithReference(kind);
            const saved = structuredClone(f.manager.document);
            const recorded = structuredClone(saved.commandLog[0]!);
            const annotated = findSketch(saved, f.sketchId)!;
            const plain = structuredClone(annotated);
            delete plain.referenceDimensions;
            saved.nodes[plain.id] = plain;
            saved.commandLog = [];
            delete saved.editHistory;
            const transaction = (payload: SerializedCommand[]) => ({
              kind: 'transaction',
              label: 'Recorded annotation',
              payload,
              replayVersion: 1,
              timestamp: new Date(0).toISOString()
            });
            const nested = [transaction([transaction([recorded])])];
            if (carrier === 'current annotation') {
              saved.nodes[annotated.id] = annotated;
            } else if (carrier === 'current nested log') {
              saved.commandLog = nested;
            } else {
              const undo = carrier.startsWith('undo');
              const wholeMap = carrier.endsWith('map');
              const beforeNode = wholeMap ? saved.nodes : plain;
              const afterNode = wholeMap
                ? { ...saved.nodes, [annotated.id]: annotated }
                : annotated;
              const change: DocumentChange = carrier.includes('node')
                ? {
                    kind: 'value',
                    field: 'nodes',
                    ...(wholeMap ? {} : { key: annotated.id }),
                    before: undo ? afterNode : beforeNode,
                    after: undo ? beforeNode : afterNode
                  }
                : carrier.includes('splice')
                  ? {
                      kind: 'splice',
                      field: 'commandLog',
                      index: 0,
                      before: undo ? nested : [],
                      after: undo ? [] : nested
                    }
                  : {
                      kind: 'value',
                      field: 'commandLog',
                      before: undo ? nested : [],
                      after: undo ? [] : nested
                    };
              saved.editHistory = {
                schemaVersion: 1,
                projectId: saved.projectId,
                actorUserId: saved.ownerUserId,
                cursor: undo ? 1 : 0,
                trimmed: 0,
                entries: [
                  {
                    id: 'history_composite_carrier',
                    label: 'Saved composite annotation',
                    changes: [change]
                  }
                ]
              };
            }
            expect(normalizeDocument(saved).editHistory, carrier).toEqual(
              saved.editHistory
            );
            expectOldCompositeCarrierRefused(
              withCarrierVersion(saved, version),
              carrier
            );
          }
        }
      );
    }
  );

  it.each(['current', 'undo', 'redo'] as const)(
    'rejects malformed replay-only target descriptors in %s log data',
    (location) => {
      const f = managerWithReference();
      const saved = structuredClone(f.manager.document);
      const malformed = structuredClone(
        saved.commandLog[0]!
      ) as SerializedCommand<{
        data: SketchReferenceDimensionData;
      }>;
      const data = malformed.payload.data;
      if (
        data.dimensionKind !== 'distance' ||
        !isSketchCompositeCornerTarget(data.a)
      )
        throw new Error('Expected named corner');
      data.a.topology.version = 2 as 1;
      findSketch(saved, f.sketchId)!.referenceDimensions = [];
      saved.commandLog = location === 'current' ? [malformed] : [];
      saved.editHistory =
        location === 'current'
          ? undefined
          : {
              schemaVersion: 1,
              projectId: saved.projectId,
              actorUserId: saved.ownerUserId,
              cursor: location === 'undo' ? 1 : 0,
              trimmed: 0,
              entries: [
                {
                  id: 'history_malformed_log',
                  label: 'Saved malformed reference log',
                  changes: [
                    {
                      kind: 'splice',
                      field: 'commandLog',
                      index: 0,
                      before: location === 'undo' ? [malformed] : [],
                      after: location === 'redo' ? [malformed] : []
                    }
                  ]
                }
              ]
            };
      expect(() => normalizeDocument(saved)).toThrow(
        /replay targets are malformed/
      );
    }
  );

  it('keeps the existing corrupt-undo recovery policy for unreadable logs', () => {
    const f = fixture();
    const saved = structuredClone(f.document);
    saved.editHistory = { schemaVersion: 99 } as never;
    expect(normalizeDocument(saved).editHistory).toBeUndefined();
  });

  it.each(['current', 'undo', 'redo'] as const)(
    'rejects malformed composite targets retained in %s nodes',
    (location) => {
      const f = managerWithReference();
      if (location === 'undo')
        f.manager.execute(
          commandFactories.deleteSketchReferenceDimension({
            sketchId: f.sketchId,
            annotationId: f.annotationId
          })
        );
      if (location === 'redo') f.manager.undo();
      const saved = structuredClone(f.manager.document);
      let touched = false;
      for (const node of documentNodesWithHistory(saved)) {
        if (node.kind !== 'sketch') continue;
        for (const reference of node.referenceDimensions ?? []) {
          if (
            reference.data.dimensionKind !== 'distance' ||
            !isSketchCompositeCornerTarget(reference.data.a)
          )
            continue;
          reference.data.a.index = 0.5;
          touched = true;
        }
      }
      expect(touched).toBe(true);
      expect(() => normalizeDocument(saved)).toThrow(/Reference dimensions/);
    }
  );

  it('loads legacy parametric objects unchanged without synthesized targets or lines', () => {
    const f = addSketchFeature(
      createProjectDocument('Legacy composites', toUserId('user_test')),
      {
        name: 'Legacy',
        plane: 'XY',
        objects: [
          {
            objectKind: 'rectangle',
            width: 20,
            height: 12,
            centerX: 0,
            centerY: 0
          },
          {
            objectKind: 'polygon',
            sides: 6,
            radius: 8,
            centerX: 30,
            centerY: 0
          }
        ]
      }
    );
    for (
      let version = 1;
      version < PROJECT_DOCUMENT_SCHEMA_VERSION;
      version++
    ) {
      const saved = structuredClone(f.document);
      saved.schemaVersion = version as typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
      const loaded = normalizeDocument(saved);
      expect(loaded.nodes).toEqual(f.document.nodes);
      expect(loaded.commandLog).toEqual(f.document.commandLog);
      expect(findSketch(loaded, f.sketchId)!.composites).toBeUndefined();
      expect(
        findSketch(loaded, f.sketchId)!.referenceDimensions
      ).toBeUndefined();
    }
  });
});
