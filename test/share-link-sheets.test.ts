import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  normalizeDocument,
  setShareLinkSheets,
  shareLinkSheets,
  sharedProjectSnapshotDocument,
  withShareLinkSheets
} from '@openzcad/document-core';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';
import {
  assertDrawingSet,
  toUserId,
  type BodyId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';

function sheet(name: string, bodyId: BodyId): DrawingSheet {
  const id = name.replace(/\W/g, '').toLowerCase();
  return {
    sheetId: `dsht_${id}` as DrawingSheetId,
    name,
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: { author: 'A. Author' },
    source: { fingerprint: 'v1:test' },
    views: [
      {
        viewId: `dvw_${id}` as DrawingViewId,
        orientation: 'front',
        bodyIds: [bodyId],
        centerMm: { x: 100, y: 100 },
        hiddenLines: true
      }
    ]
  };
}

function withSheets(): CommandManager {
  const initial = addPrimitiveFeature(
    createProjectDocument('Bracket', toUserId('user_owner')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 6 }
    }
  );
  const manager = new CommandManager(initial);
  for (const name of ['Assembly', 'Detail', 'Notes'])
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheet(name, initial.bodyOrder[0]!)
      })
    );
  return manager;
}

const ids = (document: ProjectDocument) =>
  shareLinkSheets(document).map((entry) => entry.name);

describe('L08 drawings on share links', () => {
  it('shares no sheet until one is chosen, then only the chosen ones', () => {
    const manager = withSheets();
    const before = manager.document;
    expect(ids(before)).toEqual([]);
    expect('drawings' in sharedProjectSnapshotDocument(before)).toBe(false);

    const next = manager.setShareLinkSheets([
      'dsht_notes',
      'dsht_assembly',
      'dsht_missing',
      'dsht_notes'
    ]);
    // Sheet order, duplicates and unknown ids dropped.
    expect(next.shareLinkSheetIds).toEqual(['dsht_assembly', 'dsht_notes']);
    expect(ids(next)).toEqual(['Assembly', 'Notes']);
    // A forward write: one revision, the version advanced, no undo entry.
    expect(next.version).toBe(before.version + 1);
    expect(next.revisions.at(-1)?.reason).toBe(
      'Choose drawings for share links'
    );
    expect(manager.setShareLinkSheets(['dsht_assembly', 'dsht_notes'])).toBe(
      next
    );

    const snapshot = sharedProjectSnapshotDocument(next);
    expect(snapshot.drawings?.sheets.map((entry) => entry.name)).toEqual([
      'Assembly',
      'Notes'
    ]);
    // Whole sheets, title block as drawn, and still a valid drawing set.
    expect(snapshot.drawings?.sheets[0]?.titleBlock.author).toBe('A. Author');
    expect(() => assertDrawingSet(snapshot.drawings)).not.toThrow();
    expect('shareLinkSheetIds' in snapshot).toBe(false);
    // Copies: changing the snapshot leaves the project alone.
    snapshot.drawings!.sheets[0]!.name = 'Changed';
    expect(next.drawings?.sheets[0]?.name).toBe('Assembly');

    // Clearing the choice removes the field and shares nothing again.
    const cleared = setShareLinkSheets(next, []);
    expect('shareLinkSheetIds' in cleared).toBe(false);
    expect('drawings' in sharedProjectSnapshotDocument(cleared)).toBe(false);
  });

  it('follows sheet deletion and survives undo of a model edit', () => {
    const manager = withSheets();
    manager.setShareLinkSheets(['dsht_detail']);
    manager.execute(
      commandFactories.setParameter({ name: 'width', expression: '30' })
    );
    manager.undo();
    expect(ids(manager.document)).toEqual(['Detail']);
    manager.execute(
      commandFactories.deleteDrawingSheet({
        sheetId: 'dsht_detail' as DrawingSheetId
      })
    );
    expect(ids(manager.document)).toEqual([]);
    expect('drawings' in sharedProjectSnapshotDocument(manager.document)).toBe(
      false
    );
  });

  it('drops a malformed choice on load rather than failing the document', () => {
    const document = withShareLinkSheets(withSheets().document, [
      'dsht_assembly'
    ]);
    expect(normalizeDocument(document).shareLinkSheetIds).toEqual([
      'dsht_assembly'
    ]);
    for (const bad of ['dsht_assembly', [1], ['a', 'a'], [''.padEnd(65, 'x')]])
      expect(
        'shareLinkSheetIds' in
          normalizeDocument({
            ...document,
            shareLinkSheetIds: bad
          } as unknown as ProjectDocument)
      ).toBe(false);
  });
  it('is a document the account stores as sent', () => {
    const manager = withSheets();
    const document = manager.setShareLinkSheets(['dsht_assembly']);
    expect(() =>
      parseSaveProjectDocumentRequest(
        {
          projectId: document.projectId,
          expectedVersion: document.version,
          document
        },
        document.projectId
      )
    ).not.toThrow();
  });
});
