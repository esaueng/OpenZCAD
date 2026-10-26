import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type DrawingAnnotationId,
  type ProjectDocument
} from '@openzcad/shared';
import { drawingBodyReplacements } from '../apps/web/src/lib/drawing/bodySuccessors';
import {
  createStarterSheet,
  drawingSourceFingerprint
} from '../apps/web/src/lib/drawing/sheetSources';
import { resolveSheetAnnotations } from '../apps/web/src/lib/drawing/annotations';

let adapter: Awaited<ReturnType<typeof createExactKernelAdapter>>;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

describe('drawing body succession', () => {
  it('explicitly updates a finishing result, preserves placement, and undoes, replays and reopens', async () => {
    let base = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('test')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 40, depth: 10 }
      }
    );
    base = { ...base, derived: await adapter.syncDocument(base) };
    const source = base.bodyOrder[0]!;
    const body = base.derived.bodyRepresentations[source]!;
    const edges = body.topology!.edges;
    const changedEdge = edges.find((edge) => edge.points.length >= 6)!;
    const sheet = createStarterSheet({
      name: 'Sheet 1',
      bodyIds: [source],
      bodies: base.derived.bodyRepresentations,
      units: 'mm',
      paper: { size: 'A3', orientation: 'landscape' },
      projectionAngle: 'first',
      fingerprint: drawingSourceFingerprint(base.derived.bodyRepresentations, [
        source
      ])!
    });
    const viewId = sheet.views[0]!.viewId;
    sheet.annotations = [changedEdge].map((edge, index) => ({
      annotationId: `dann_edge${index}` as DrawingAnnotationId,
      kind: 'note' as const,
      text: `Edge ${index}`,
      viewId,
      placementMm: { x: 12 + index, y: 8 },
      leader: { bodyId: source, hash: edge.hash, reference: edge.reference }
    }));
    const manager = new CommandManager(base);
    manager.execute(commandFactories.addDrawingSheet({ sheet }));
    manager.execute(
      commandFactories.filletEdges({
        name: 'Fillet',
        targetBodyId: source,
        edgeHashes: [changedEdge.hash],
        size: 2
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const target = manager.document.bodyOrder.at(-1)!;
    const replacements = drawingBodyReplacements(
      manager.document,
      derived.bodyRepresentations,
      [source]
    );
    expect(replacements).toEqual([{ from: source, to: target }]);
    expect(manager.document.drawings!.sheets[0]!.views[0]!.bodyIds).toEqual([
      source
    ]);
    manager.execute(
      commandFactories.updateDrawingSheet({
        sheetId: sheet.sheetId,
        source: {
          fingerprint: drawingSourceFingerprint(derived.bodyRepresentations, [
            target
          ])!
        },
        bodyReplacements: replacements!
      })
    );
    const updated = manager.document.drawings!.sheets[0]!;
    expect(updated.views.map((view) => view.bodyIds)).toEqual(
      sheet.views.map(() => [target])
    );
    expect(updated.views.map((view) => view.centerMm)).toEqual(
      sheet.views.map((view) => view.centerMm)
    );
    expect(updated.annotations!.map((entry) => entry.placementMm)).toEqual(
      sheet.annotations.map((entry) => entry.placementMm)
    );
    const refs = updated.annotations!.map((entry) =>
      entry.kind === 'note' ? entry.leader : null
    );
    expect(refs.map((ref) => ref!.hash)).toEqual([changedEdge.hash]);
    expect(refs.every((ref) => ref!.bodyId === target)).toBe(true);
    // A removed edge is visibly broken; Update never binds to a nearby edge.
    const resolutions = resolveSheetAnnotations(
      updated,
      derived.bodyRepresentations,
      'mm'
    );
    expect(
      resolutions.get(updated.annotations![0]!.annotationId)
    ).toMatchObject({ ok: false });
    manager.undo();
    expect(manager.document.drawings!.sheets[0]!.views[0]!.bodyIds).toEqual([
      source
    ]);
    manager.redo();
    expect(manager.document.drawings!.sheets[0]).toEqual(updated);
    expect(replayCommands(base, manager.document.commandLog).drawings).toEqual(
      manager.document.drawings
    );
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(reopened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(reopened.drawings).toEqual(manager.document.drawings);
    expect((await adapter.syncDocument(reopened)).warnings).toEqual([]);
  });

  it('refuses missing sources and requires an explicit source Update', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Split', toUserId('test')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    document = { ...document, derived: await adapter.syncDocument(document) };
    const source = document.bodyOrder[0]!;
    // Missing without an explicit one-to-one finishing path stays missing.
    expect(drawingBodyReplacements(document, {}, [source])).toBeNull();
    expect(
      drawingBodyReplacements(
        document,
        {
          [source]: {
            ...document.derived.bodyRepresentations[source]!,
            consumed: true
          }
        },
        [source]
      )
    ).toBeNull();
    expect(
      drawingBodyReplacements(document, document.derived.bodyRepresentations, [
        source
      ])
    ).toEqual([]);
    const manager = new CommandManager(document);
    const sheet = createStarterSheet({
      name: 'Sheet',
      bodyIds: [source],
      bodies: document.derived.bodyRepresentations,
      units: 'mm',
      paper: { size: 'A3', orientation: 'landscape' },
      projectionAngle: 'first',
      fingerprint: 'v1:before'
    });
    manager.execute(commandFactories.addDrawingSheet({ sheet }));
    expect(() =>
      manager.execute(
        commandFactories.updateDrawingSheet({
          sheetId: sheet.sheetId,
          bodyReplacements: [{ from: source, to: source }]
        })
      )
    ).toThrow(/explicit source Update/);
  });

  it('ignores additive results, follows a unique finishing chain and refuses competing replacements', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Chain', toUserId('test')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    document = { ...document, derived: await adapter.syncDocument(document) };
    const source = document.bodyOrder[0]!;
    const body = document.derived.bodyRepresentations[source]!;
    document = commandFactories
      .thickenFace({
        name: 'Thicken',
        targetBodyId: source,
        faceHash: body.topology!.faces[0]!.hash,
        thickness: 1
      })
      .apply(document);
    const additive = document.bodyOrder.at(-1)!;
    const additiveBodies = {
      [source]: body,
      [additive]: { ...body, bodyId: additive }
    };
    expect(drawingBodyReplacements(document, additiveBodies, [source])).toEqual(
      []
    );
    // An additive result cannot stand in for a genuinely missing source.
    expect(
      drawingBodyReplacements(
        document,
        { [additive]: additiveBodies[additive]! },
        [source]
      )
    ).toBeNull();
    const fillet = (targetBodyId: typeof source) =>
      commandFactories.filletEdges({
        name: 'Fillet',
        targetBodyId,
        edgeHashes: [body.topology!.edges[0]!.hash],
        size: 1
      });
    document = fillet(source).apply(document);
    const middle = document.bodyOrder.at(-1)!;
    document = fillet(middle).apply(document);
    const target = document.bodyOrder.at(-1)!;
    const bodies = {
      ...additiveBodies,
      [source]: { ...body, consumed: true },
      [middle]: { ...body, bodyId: middle, consumed: true },
      [target]: { ...body, bodyId: target }
    };
    expect(drawingBodyReplacements(document, bodies, [source])).toEqual([
      { from: source, to: target }
    ]);
    document = fillet(source).apply(document);
    const competing = document.bodyOrder.at(-1)!;
    expect(
      drawingBodyReplacements(
        document,
        {
          ...bodies,
          [competing]: { ...body, bodyId: competing }
        },
        [source]
      )
    ).toBeNull();
  });
});
