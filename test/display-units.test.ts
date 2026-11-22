import { describe, expect, it } from 'vitest';
import {
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  setDisplayUnits
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  isGeometryFreeCommandKind,
  replayCommands
} from '@openzcad/command-system';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  convertLength,
  displayUnitsError,
  documentDisplayUnits,
  isDocumentHistory,
  toUserId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';

/**
 * I03 display units (schema v142): a project created in one unit shows and
 * takes lengths in another. Only `displayUnits` changes; every stored length
 * stays in `units`, so the model is untouched.
 */

function newDocument(units: UnitSystem = 'mm'): ProjectDocument {
  return createProjectDocument('Units', toUserId('user_units'), units);
}

describe('display units on the document', () => {
  it('default to the units the project was created in', () => {
    const fresh = newDocument('cm');
    expect(fresh.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect('displayUnits' in fresh).toBe(false);
    expect(documentDisplayUnits(fresh)).toBe('cm');
  });

  it('change only how lengths are shown, never a stored value', () => {
    const document = newDocument('mm');
    const shown = setDisplayUnits(document, { units: 'inch' });
    expect(shown.displayUnits).toBe('inch');
    expect(documentDisplayUnits(shown)).toBe('inch');
    expect(shown.units).toBe('mm');
    expect(shown.version).toBe(document.version + 1);
    // Nothing else the model is built from moved.
    const { displayUnits: _shown, version: _v, ...rest } = shown;
    const { version: _before, ...original } = document;
    expect(rest).toEqual(original);
    // The same unit again is no edit at all.
    expect(setDisplayUnits(shown, { units: 'inch' })).toBe(shown);
  });

  it("clears the field when switched back to the project's own unit", () => {
    const shown = setDisplayUnits(newDocument('mm'), { units: 'inch' });
    for (const units of ['mm', null] as const) {
      const back = setDisplayUnits(shown, { units });
      expect('displayUnits' in back).toBe(false);
      expect(documentDisplayUnits(back)).toBe('mm');
    }
    // Choosing the own unit on a document that never switched changes nothing.
    const fresh = newDocument('mm');
    expect(setDisplayUnits(fresh, { units: 'mm' })).toBe(fresh);
  });

  it('refuses a unit it does not know', () => {
    for (const bad of ['ft', 'INCH', '', 'constructor'])
      expect(() =>
        setDisplayUnits(newDocument(), { units: bad as UnitSystem })
      ).toThrow(/mm, cm, m or inch/);
    expect(displayUnitsError('inch')).toBeNull();
    expect(displayUnitsError(3)).not.toBeNull();
    // A stored value that is not a unit reads as the document's own.
    expect(
      documentDisplayUnits({ units: 'cm', displayUnits: 'ft' as UnitSystem })
    ).toBe('cm');
  });

  it('is stored, and refused on a document that declares an older schema', () => {
    // v137 is the schema this builds on; v138–v141 are claimed by other
    // pull requests, none of which knows display units.
    const beforeDisplayUnits = 141;
    const shown = setDisplayUnits(newDocument(), { units: 'inch' });
    expect(assertStorableDocument(shown).displayUnits).toBe('inch');
    for (const bad of ['ft', 1, {}, null])
      expect(() =>
        assertStorableDocument({ ...shown, displayUnits: bad })
      ).toThrow();
    expect(() =>
      normalizeDocument({
        ...shown,
        schemaVersion: beforeDisplayUnits
      } as never)
    ).toThrow(/Display units require project schema v142/);
    expect(() =>
      setDisplayUnits(
        { ...newDocument(), schemaVersion: beforeDisplayUnits } as never,
        { units: 'inch' }
      )
    ).toThrow(/v142/);
  });

  it('is one undoable, replayable, geometry-free command', () => {
    const manager = new CommandManager(newDocument('mm'));
    manager.execute(commandFactories.setDisplayUnits({ units: 'inch' }));
    expect(manager.document.displayUnits).toBe('inch');
    expect(manager.document.commandLog.at(-1)?.label).toBe(
      'Show lengths in inches'
    );
    expect(isGeometryFreeCommandKind('displayUnits.set')).toBe(true);
    expect(manager.undoIsGeometryFree).toBe(true);
    const projectId = manager.document.projectId;
    expect(isDocumentHistory(manager.document.editHistory, projectId)).toBe(
      true
    );
    manager.undo();
    expect(manager.document.displayUnits).toBeUndefined();
    expect(manager.redoIsGeometryFree).toBe(true);
    expect(
      Object.keys(JSON.parse(JSON.stringify(manager.document)) as object)
    ).not.toContain('displayUnits');
    manager.redo();
    expect(manager.document.displayUnits).toBe('inch');
    const replayed = replayCommands(
      newDocument('mm'),
      manager.document.commandLog
    );
    expect(replayed.displayUnits).toBe('inch');
    // A stored history change that is not a unit is refused.
    const history = structuredClone(manager.document.editHistory!);
    const change = history.entries
      .at(-1)!
      .changes.find((entry) => entry.field === 'displayUnits')!;
    (change as { after: unknown }).after = 'furlong';
    expect(isDocumentHistory(history, projectId)).toBe(false);
  });
});

describe('length conversion between units', () => {
  it('is exact for the defined factors and the identity for one unit', () => {
    expect(convertLength(1, 'inch', 'mm')).toBe(25.4);
    expect(convertLength(25.4, 'mm', 'inch')).toBe(1);
    expect(convertLength(2, 'm', 'cm')).toBe(200);
    expect(convertLength(0.1, 'mm', 'mm')).toBe(0.1);
    // A round trip lands back on the value.
    expect(
      convertLength(convertLength(17.3, 'mm', 'inch'), 'inch', 'mm')
    ).toBeCloseTo(17.3, 12);
  });
});
