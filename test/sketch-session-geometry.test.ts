import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  findSketch,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

function fixture() {
  const f = addSketchFeature(
    createProjectDocument('Session geometry', toUserId('user_session')),
    {
      name: 'Line',
      plane: 'XY',
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 }]
    }
  );
  const id = findSketch(f.document, f.sketchId)!.objectIds[0]!;
  const derived: ProjectDocument['derived'] = {
    ...f.document.derived,
    sketchGeometry: {
      projectId: f.document.projectId,
      documentVersion: f.document.version,
      objects: { [id]: { objectKind: 'line', x1: 0, y1: 0, x2: 32, y2: 0 } }
    }
  };
  return { ...f, id, derived };
}

describe('session-only solved sketch geometry attachment', () => {
  it('attaches matching geometry without changing canonical content or body projection', () => {
    const f = fixture();
    const before = structuredClone(f.document);
    const attached = attachDerivedState(f.document, f.derived);
    expect(attached.version).toBe(f.document.version);
    expect(attached.nodes).toBe(f.document.nodes);
    expect(attached.derived.bodyRepresentations).toBe(
      f.derived.bodyRepresentations
    );
    expect(attached.derived.sketchGeometry).toBe(f.derived.sketchGeometry);
    expect(
      Object.getOwnPropertyDescriptor(attached.derived, 'sketchGeometry')
        ?.enumerable
    ).toBe(false);
    expect(f.document).toEqual(before);
    expect(f.derived.sketchGeometry).toBeDefined();
  });
  it.each(['stale', 'future', 'foreign'] as const)(
    'does not attach a %s proof',
    (kind) => {
      const f = fixture();
      const geometry = f.derived.sketchGeometry!;
      f.derived.sketchGeometry = {
        ...geometry,
        ...(kind === 'foreign'
          ? {
              projectId:
                `${f.document.projectId}_foreign` as typeof f.document.projectId
            }
          : {
              documentVersion: f.document.version + (kind === 'stale' ? -1 : 1)
            })
      };
      const attached = attachDerivedState(f.document, f.derived);
      expect(attached.derived.sketchGeometry).toBeUndefined();
      expect(attached.nodes).toBe(f.document.nodes);
      expect(attached.derived.bodyRepresentations).toBe(
        f.derived.bodyRepresentations
      );
    }
  );
  it('omits the channel from JSON, structured clones, native/persistence projections and undo history', () => {
    const f = fixture();
    const attached = attachDerivedState(f.document, f.derived);
    const saved = JSON.parse(JSON.stringify(attached)) as ProjectDocument;
    expect(saved.derived).not.toHaveProperty('sketchGeometry');
    expect(structuredClone(attached).derived).not.toHaveProperty(
      'sketchGeometry'
    );
    expect(withoutDerivedProjection(attached).derived).not.toHaveProperty(
      'sketchGeometry'
    );
    const manager = new CommandManager(attached);
    manager.execute(
      commandFactories.setParameter({ name: 'width', expression: '32' })
    );
    expect(manager.document.derived).toBe(attached.derived);
    expect(manager.document.derived.sketchGeometry?.documentVersion).not.toBe(
      manager.document.version
    );
    expect(JSON.stringify(manager.document.editHistory)).not.toContain(
      'sketchGeometry'
    );
    manager.undo();
    expect(manager.document.derived.sketchGeometry?.documentVersion).not.toBe(
      manager.document.version
    );
    expect(attached.derived.sketchGeometry?.documentVersion).toBe(
      attached.version
    );
  });
  it('strips a matching but untrusted incoming channel on normalize/reopen', () => {
    const f = fixture();
    const incoming = { ...f.document, derived: f.derived };
    const before = structuredClone(incoming);
    const normalized = normalizeDocument(incoming);
    expect(normalized.derived).not.toHaveProperty('sketchGeometry');
    expect(normalized.derived.bodyRepresentations).toBe(
      incoming.derived.bodyRepresentations
    );
    expect(normalized.nodes).toEqual(incoming.nodes);
    expect(incoming).toEqual(before);
    const attached = attachDerivedState(f.document, f.derived);
    expect(normalizeDocument(attached).derived).not.toHaveProperty(
      'sketchGeometry'
    );
    expect(attached.derived.sketchGeometry).toBeDefined();
  });
});
