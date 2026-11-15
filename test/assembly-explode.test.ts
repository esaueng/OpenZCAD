import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assertDocumentContentSchema,
  createProjectDocument,
  deriveAssemblyBom,
  mergeCollaborationDocuments,
  normalizeDocument,
  setAssemblyExplode
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  assemblyExplodeOffset,
  assemblySetError,
  solveAssembly,
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * AS03 stored exploded-view offsets (schema v61): one world translation per
 * component, edited one drag (one command, one undo step) at a time,
 * presentation only, stored canonically, and merged per part.
 */
const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function rig(): { manager: CommandManager; bodies: BodyId[] } {
  const manager = new CommandManager(
    createProjectDocument('Exploded rig', toUserId('user_explode'))
  );
  for (const name of ['Base', 'Arm', 'Pin']) {
    manager.execute(
      commandFactories.addPrimitive({
        name,
        bodyName: name,
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 5 }
      })
    );
  }
  const bodies = [...manager.document.bodyOrder];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'c_base',
          name: 'Base',
          bodyId: bodies[0]!,
          grounded: true
        },
        {
          componentId: 'c_arm',
          name: 'Arm',
          bodyId: bodies[1]!,
          grounded: false
        },
        {
          componentId: 'c_pin',
          name: 'Pin',
          bodyId: bodies[2]!,
          grounded: false
        }
      ]
    })
  );
  manager.execute(
    commandFactories.addAssemblyJoint({
      joint: {
        id: 'j_arm',
        name: 'Hinge',
        kind: 'revolute',
        parent: { componentId: 'c_base', frame: PIVOT },
        child: { componentId: 'c_arm', frame: PIVOT },
        values: [30],
        limits: [null]
      }
    })
  );
  return { manager, bodies };
}

const explode = (
  manager: CommandManager,
  offsets: Parameters<typeof commandFactories.setAssemblyExplode>[0]['offsets'],
  reset = false
) =>
  manager.execute(
    commandFactories.setAssemblyExplode({
      offsets,
      ...(reset ? { reset } : {})
    })
  );

const offsetsOf = (document: ProjectDocument) =>
  document.assembly?.explode?.offsets;

describe('assembly.explode.set (AS03)', () => {
  it('stores a dragged offset as one undo step and redoes it', () => {
    const { manager } = rig();
    explode(manager, { c_arm: { x: 0, y: 0, z: 25 } });
    expect(offsetsOf(manager.document)).toEqual({
      c_arm: { x: 0, y: 0, z: 25 }
    });
    explode(manager, { c_arm: { x: 0, y: 0, z: 40 } });
    expect(assemblyExplodeOffset(manager.document.assembly!, 'c_arm')).toEqual({
      x: 0,
      y: 0,
      z: 40
    });
    manager.undo();
    expect(offsetsOf(manager.document)).toEqual({
      c_arm: { x: 0, y: 0, z: 25 }
    });
    manager.undo();
    expect(manager.document.assembly?.explode).toBeUndefined();
    manager.redo();
    expect(offsetsOf(manager.document)).toEqual({
      c_arm: { x: 0, y: 0, z: 25 }
    });
  });

  it('keeps offsets in display order, drops zero and null, and resets in one step', () => {
    const { manager } = rig();
    explode(manager, { c_pin: { x: 10, y: 0, z: 0 } });
    explode(manager, { c_base: { x: 0, y: -15, z: 0 } });
    // Display order, not edit order: the stored record is canonical.
    expect(Object.keys(offsetsOf(manager.document)!)).toEqual([
      'c_base',
      'c_pin'
    ]);
    explode(manager, { c_pin: { x: 0, y: 0, z: 0 } });
    expect(offsetsOf(manager.document)).toEqual({
      c_base: { x: 0, y: -15, z: 0 }
    });
    explode(manager, { c_base: null });
    expect(manager.document.assembly?.explode).toBeUndefined();
    explode(manager, {
      c_arm: { x: 1, y: 2, z: 3 },
      c_pin: { x: 4, y: 5, z: 6 }
    });
    explode(manager, {}, true);
    expect(manager.document.assembly?.explode).toBeUndefined();
    manager.undo();
    expect(Object.keys(offsetsOf(manager.document)!)).toEqual([
      'c_arm',
      'c_pin'
    ]);
  });

  it('records no edit when nothing changes', () => {
    const { manager } = rig();
    const before = manager.document;
    explode(manager, { c_arm: null });
    expect(manager.document).toBe(before);
  });

  it('refuses an unknown part and a non-finite offset', () => {
    const { manager } = rig();
    expect(() =>
      setAssemblyExplode(manager.document, {
        offsets: { c_missing: { x: 1, y: 0, z: 0 } }
      })
    ).toThrow(/Component c_missing not found/);
    expect(() =>
      setAssemblyExplode(manager.document, {
        offsets: { c_arm: { x: Number.NaN, y: 0, z: 0 } }
      })
    ).toThrow(/finite/);
  });

  it('removes a deleted part’s offset with it, and undo brings both back', () => {
    const { manager } = rig();
    explode(manager, { c_pin: { x: 10, y: 0, z: 0 } });
    manager.execute(
      commandFactories.deleteAssemblyComponent({ componentId: 'c_pin' })
    );
    expect(manager.document.assembly?.explode).toBeUndefined();
    manager.undo();
    expect(offsetsOf(manager.document)).toEqual({
      c_pin: { x: 10, y: 0, z: 0 }
    });
  });

  it('is presentation only: the solve, the poses and the BOM do not change', () => {
    const { manager } = rig();
    const set = manager.document.assembly!;
    const bom = deriveAssemblyBom(manager.document, () => true);
    explode(manager, { c_arm: { x: 0, y: 0, z: 25 } });
    const exploded = manager.document.assembly!;
    const { explode: _explode, ...withoutExplode } = exploded;
    expect(withoutExplode).toEqual(set);
    expect(solveAssembly(exploded).poses).toEqual(solveAssembly(set).poses);
    expect(deriveAssemblyBom(manager.document, () => true)).toEqual(bom);
  });

  it('reopens exactly after save', () => {
    const { manager } = rig();
    explode(manager, {
      c_arm: { x: 0, y: 0, z: 25 },
      c_pin: { x: -12.5, y: 0, z: 0 }
    });
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(reopened.assembly).toEqual(manager.document.assembly);
    expect(reopened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    // The reopened history still undoes the last drag.
    const again = new CommandManager(reopened);
    again.undo();
    expect(again.document.assembly?.explode).toBeUndefined();
  });
});

describe('exploded view schema and validation (v61)', () => {
  it('is refused below schema v61, in the document and in its commands', () => {
    const { manager } = rig();
    const old = { ...manager.document, schemaVersion: 60 } as ProjectDocument;
    expect(() =>
      setAssemblyExplode(old, { offsets: { c_arm: { x: 1, y: 0, z: 0 } } })
    ).toThrow('Exploded views require project schema v61 or newer.');
    explode(manager, { c_arm: { x: 1, y: 0, z: 0 } });
    const stamped = {
      ...manager.document,
      schemaVersion: 60
    } as ProjectDocument;
    expect(() => assertDocumentContentSchema(stamped)).toThrow(
      'Exploded views require project schema v61 or newer.'
    );
  });

  it('opens a v60 assembly without offsets unchanged', () => {
    const { manager } = rig();
    const document = {
      ...manager.document,
      schemaVersion: 60
    } as ProjectDocument;
    const { editHistory: _history, ...withoutHistory } = document;
    expect(() => assertDocumentContentSchema(withoutHistory)).not.toThrow();
    expect(
      normalizeDocument(withoutHistory as ProjectDocument).assembly
    ).toEqual(manager.document.assembly);
  });

  it('refuses offsets for parts not in the assembly, reserved keys and bad vectors', () => {
    const { manager } = rig();
    const set = manager.document.assembly!;
    expect(
      assemblySetError({
        ...set,
        explode: { offsets: { c_gone: { x: 1, y: 0, z: 0 } } }
      })
    ).toMatch(/not in the assembly/);
    expect(
      assemblySetError({
        ...set,
        explode: { offsets: JSON.parse('{"__proto__":{"x":1,"y":0,"z":0}}') }
      })
    ).toMatch(/not in the assembly/);
    expect(
      assemblySetError({
        ...set,
        explode: { offsets: { c_arm: { x: 1e12, y: 0, z: 0 } } }
      })
    ).toMatch(/no usable offset/);
    expect(assemblySetError({ ...set, explode: { offsets: [] } })).toMatch(
      /malformed/
    );
    expect(
      assemblySetError({
        ...set,
        explode: { offsets: { c_arm: { x: 1, y: 2, z: 3 } } }
      })
    ).toBeNull();
  });
});

describe('room merges of exploded-view edits', () => {
  it('keeps offsets two devices gave different parts once the view has one', () => {
    const { manager } = rig();
    explode(manager, { c_base: { x: 0, y: -15, z: 0 } });
    const base = manager.document;
    const latest = new CommandManager(structuredClone(base));
    const incoming = new CommandManager(structuredClone(base));
    explode(latest, { c_arm: { x: 0, y: 0, z: 25 } });
    explode(incoming, { c_pin: { x: 10, y: 0, z: 0 } });
    const merged = mergeCollaborationDocuments(
      base,
      latest.document,
      incoming.document
    );
    expect(merged).not.toBeNull();
    expect(offsetsOf(merged!)).toEqual({
      c_base: { x: 0, y: -15, z: 0 },
      c_arm: { x: 0, y: 0, z: 25 },
      c_pin: { x: 10, y: 0, z: 0 }
    });
  });

  it('asks rather than merging the first offsets two devices made at once', () => {
    // With no exploded view in the base there is no record to merge into:
    // the generic merge refuses, and the submitter chooses. Nothing is lost.
    const { manager } = rig();
    const base = manager.document;
    const latest = new CommandManager(structuredClone(base));
    const incoming = new CommandManager(structuredClone(base));
    explode(latest, { c_arm: { x: 0, y: 0, z: 25 } });
    explode(incoming, { c_pin: { x: 10, y: 0, z: 0 } });
    expect(
      mergeCollaborationDocuments(base, latest.document, incoming.document)
    ).toBeNull();
  });

  it('keeps an offset made on one device and a pose made on the other', () => {
    const { manager } = rig();
    const base = manager.document;
    const latest = new CommandManager(structuredClone(base));
    const incoming = new CommandManager(structuredClone(base));
    explode(latest, { c_arm: { x: 0, y: 0, z: 25 } });
    incoming.execute(
      commandFactories.setAssemblyPose({ values: { j_arm: [60] } })
    );
    const merged = mergeCollaborationDocuments(
      base,
      latest.document,
      incoming.document
    );
    expect(merged).not.toBeNull();
    expect(offsetsOf(merged!)).toEqual({ c_arm: { x: 0, y: 0, z: 25 } });
    expect(merged!.assembly!.joints[0]!.values).toEqual([60]);
  });

  it('refuses two different offsets for the same part', () => {
    const { manager } = rig();
    const base = manager.document;
    const latest = new CommandManager(structuredClone(base));
    const incoming = new CommandManager(structuredClone(base));
    explode(latest, { c_arm: { x: 0, y: 0, z: 25 } });
    explode(incoming, { c_arm: { x: 0, y: 0, z: 40 } });
    expect(
      mergeCollaborationDocuments(base, latest.document, incoming.document)
    ).toBeNull();
  });

  it('refuses an offset on a part the other device removed', () => {
    const { manager } = rig();
    const base = manager.document;
    const latest = new CommandManager(structuredClone(base));
    const incoming = new CommandManager(structuredClone(base));
    latest.execute(
      commandFactories.deleteAssemblyComponent({ componentId: 'c_pin' })
    );
    explode(incoming, { c_pin: { x: 10, y: 0, z: 0 } });
    expect(
      mergeCollaborationDocuments(base, latest.document, incoming.document)
    ).toBeNull();
  });
});
